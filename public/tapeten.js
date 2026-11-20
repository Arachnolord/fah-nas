// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tapeten-Auswahl (Betreiber 15.10.2026: „auf ein folder verweisen um zwischen verschiedene hochgeladene wallpaper
// auswählen zu können und zudem auch die skalierung wählen“): eigene Sammlung (/api/hintergrund/liste) und ein Ordner
// aus einer Freigabe (dateien.liste mit den Rechten des Nutzers). Genutzt vom Fenster „Darstellung“ und der
// Dashboard-Kachel „Tapete“.

import { api, csrfToken } from './api.js';
import { anwenden, aktuelleDarstellung, normal, tapeteUrl, gleicheTapete } from './darstellung.js';

export const BILD = /\.(jpe?g|png|webp|gif|avif)$/i;
export const VIDEO = /\.(mp4|webm)$/i;
export const MAX_ORDNER = 300; // mehr Dateien zeigt die Auswahl nicht an

/** Versionskennung einer Freigabe-Datei aus Änderungszeit + Größe (wechselt mit dem Dateistand). */
export function dateiVersion(e) {
  const zeit = Math.max(0, Math.floor((Date.parse(e && e.geaendert) || 0) / 1000));
  const groesse = Math.max(0, Number(e && e.groesse) || 0);
  return `${zeit.toString(36)}${groesse.toString(36)}`.slice(0, 16) || '0';
}

/** Einträge aus dateien.liste → Tapeten (nur Bilder/Videos, nach Namen sortiert, höchstens MAX_ORDNER). */
export function ausOrdnerliste(ordner, eintraege) {
  const aus = [];
  for (const e of Array.isArray(eintraege) ? eintraege : []) {
    if (!e || e.art !== 'datei' || typeof e.name !== 'string') continue;
    const art = VIDEO.test(e.name) ? 'video' : BILD.test(e.name) ? 'bild' : null;
    if (!art) continue;
    aus.push({ quelle: 'ordner', freigabe: ordner.freigabe, pfad: ordner.pfad ? `${ordner.pfad}/${e.name}` : e.name, art, v: dateiVersion(e), name: e.name });
  }
  aus.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return aus.slice(0, MAX_ORDNER);
}

/** Eigene Sammlung → [{quelle:'eigen', id, art, v, name, groesse}] und Höchstzahl. */
export async function eigeneLaden() {
  const r = await fetch('/api/hintergrund/liste', { credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error((j.fehler && j.fehler.meldung) || `HTTP ${r.status}`);
  const e = j.ergebnis || {};
  return { eintraege: (e.eintraege || []).map((x) => ({ quelle: 'eigen', id: x.id, art: x.art, v: x.v, name: x.name, groesse: x.groesse })), max: e.max || 30 };
}

/** Bilder/Videos des Tapeten-Ordners. */
export async function ordnerLaden(ordner) {
  if (!ordner) return [];
  const r = await api('dateien.liste', { freigabe: ordner.freigabe, pfad: ordner.pfad });
  return ausOrdnerliste(ordner, Array.isArray(r) ? r : (r && r.eintraege) || []);
}

/** Alle wählbaren Tapeten in Anzeigereihenfolge (eigene zuerst). Fehler beim Ordner → `ordnerFehler`. */
export async function alleLaden(d = aktuelleDarstellung()) {
  const [eigene, ordner] = await Promise.allSettled([eigeneLaden(), ordnerLaden(d.tapetenordner)]);
  return {
    eigene: eigene.status === 'fulfilled' ? eigene.value.eintraege : [],
    max: eigene.status === 'fulfilled' ? eigene.value.max : 30,
    eigeneFehler: eigene.status === 'rejected' ? eigene.reason : null,
    ordner: ordner.status === 'fulfilled' ? ordner.value : [],
    ordnerFehler: ordner.status === 'rejected' ? ordner.reason : null,
  };
}

/** Vorschaubild-Adresse (Freigabe: Vorschaudienst, eigene Bilder: die Datei selbst; eigene Videos: null → <video>). */
export function vorschauAdresse(t, groesse = 256) {
  if (!t) return null;
  const k = encodeURIComponent;
  if (t.quelle === 'ordner') return `/api/dateien/vorschau?freigabe=${k(t.freigabe)}&pfad=${k(t.pfad)}&groesse=${groesse}&v=${k(t.v)}`;
  return t.art === 'bild' ? tapeteUrl(t) : null;
}

/** Nachbar in der Liste (Richtung +1/-1, ringsum); ohne aktuelle Tapete die erste bzw. letzte. */
export function nachbar(liste, aktuell, richtung = 1) {
  if (!liste.length) return null;
  const i = liste.findIndex((x) => gleicheTapete(x, aktuell));
  if (i < 0) return richtung > 0 ? liste[0] : liste[liste.length - 1];
  return liste[(i + richtung + liste.length) % liste.length];
}

/** Nur die Felder, die in den Einstellungen stehen. */
export function auswahlForm(t) {
  if (!t) return null;
  return t.quelle === 'ordner' ? { quelle: 'ordner', freigabe: t.freigabe, pfad: t.pfad, art: t.art, v: t.v } : { quelle: 'eigen', id: t.id, art: t.art, v: t.v };
}

/** Darstellung ändern, sofort anwenden und im Konto speichern. Gibt die neue Darstellung zurück. */
export async function darstellungAendern(nutzer, teil) {
  const d = anwenden(normal({ ...aktuelleDarstellung(), ...teil }));
  await api('nutzer.einstellungen.setzen', { name: nutzer, bereich: 'darstellung', wert: d });
  return d;
}

/** Datei in die eigene Sammlung hochladen → Tapete. */
export async function hochladen(datei) {
  const antwort = await fetch(`/api/hintergrund?name=${encodeURIComponent(datei.name || '')}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': datei.type || 'application/octet-stream', 'X-FAHNAS-CSRF': csrfToken() }, body: datei });
  const j = await antwort.json().catch(() => ({}));
  if (!antwort.ok || !j.ok) throw new Error((j.fehler && j.fehler.meldung) || `HTTP ${antwort.status}`);
  const e = j.ergebnis;
  return { quelle: 'eigen', id: e.id, art: e.art, v: e.v, name: e.name, groesse: e.groesse };
}

/** Eine eigene Tapete löschen. */
export async function loeschen(id) {
  const antwort = await fetch(`/api/hintergrund/loeschen?id=${encodeURIComponent(id)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-FAHNAS-CSRF': csrfToken() }, body: '{}' });
  const j = await antwort.json().catch(() => ({}));
  if (!antwort.ok || !j.ok) throw new Error((j.fehler && j.fehler.meldung) || `HTTP ${antwort.status}`);
}
