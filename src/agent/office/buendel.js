// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Bündel im Agenten (V13): Kennungen für Dokumente und eingebettete Dateien, Aufbau von inhalt.json aus dem
// Index-Eintrag, und ob für eine Freigabe planmäßige Schnappschüsse laufen (Hinweis in der Oberfläche).

import crypto from 'node:crypto';
import { kennung } from '../../gemeinsam/protokoll.js';
import { SCHEMA } from '../../gemeinsam/office.js';

export const S_ID = { typ: 'string', pflicht: true, muster: /^o[A-Za-z0-9_-]{16}$/, hinweis: 'Dokument-ID ungültig' };

/** Dokument-ID: „o“ + 16 Zeichen base64url (12 Zufallsbytes). */
export const neueOfficeId = () => kennung('o');

/** Kennung einer eingebetteten Datei im Bündel (12 Zeichen base64url). */
export function neueDateiId() { return crypto.randomBytes(9).toString('base64url'); }

/** inhalt.json in der V13-Form; id, art, besitzer und erstellt kommen aus dem Index-Eintrag. */
export function inhaltBauen(eintrag, { version, daten, geaendert }) {
  return { format: 'fah-office', art: eintrag.art, schema: SCHEMA, id: eintrag.id, version, erstellt: eintrag.erstellt, geaendert, besitzer: eintrag.besitzer, daten };
}

/** true, wenn ein Schnappschuss-Plan für diese Freigabe mindestens einen eingeschalteten Takt hat. */
export async function schnappschuesseAn(w, freigabe) {
  const sn = await w.konfig.laden('snapshots.json', {});
  return (sn?.plaene || []).some((p) => p && p.ziel === freigabe && Object.values(p.zeitplan || {}).some((v) => v === true));
}
