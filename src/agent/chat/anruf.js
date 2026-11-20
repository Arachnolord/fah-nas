// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anrufe im Agenten (Plan 03): Die Anrufe selbst führt der Web-Dienst im Speicher; der Agent schreibt nur die Notizen in
// den Verlauf (Ende mit Dauer, verpasst in Direktnachrichten) und schickt Handy-Meldungen (V9) – nur wer anruft, nie
// mehr. Dazu die Auskunft für den TURN-Dienst (LAN-IP, an/aus, Port).

import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { MUSTER_NUTZERNAME } from '../../gemeinsam/schema.js';
import { nasNetz } from '../helfer/netzadressen.js';
import { persoenlichSenden } from '../benachrichtigung/persoenlich.js';
import { S } from './ablage.js';
import { raumFuerNutzer, nutzerDaten, anzeigename, chatEinstellungen } from './raeume.js';
import { systemEintrag, klickAdresse } from './nachrichten.js';
import { ausweisPruefen } from './gaeste.js';

export const ANRUF_ARTEN = Object.freeze(['beginn', 'ende', 'verpasst']);

const S_NUTZER = { typ: 'string', max: 31, muster: MUSTER_NUTZERNAME, hinweis: 'Nutzername ungültig' };
const SCHEMA = {
  raum: S.raum,
  art: { typ: 'string', pflicht: true, werte: ANRUF_ARTEN, hinweis: 'Art: beginn, ende oder verpasst' },
  video: { typ: 'boolean', standard: false },
  dauer_s: { typ: 'integer', min: 0, max: 86_400, standard: 0 },
  aktiv: { typ: 'array', max: 100, elemente: S_NUTZER, standard: [] },
};

/** Handy-Meldung an NAS-Mitglieder (nicht der Anrufer, nicht gerade aktiv, nicht stumm) – ohne zu warten. */
async function pushen(w, raum, { von, vonName, aktiv, text, art }) {
  const namen = await nutzerDaten(w);
  const stumm = (n) => { const s = namen.get(n)?.einstellungen?.chat?.stumm; return Array.isArray(s) && s.includes(raum.id); };
  const ziele = Object.keys(raum.mitglieder || {}).filter((n) => n !== von && !aktiv.includes(n) && !stumm(n)).sort();
  if (!ziele.length) return [];
  const klick = await klickAdresse(w, raum.id);
  const senden = typeof w.persoenlichSenden === 'function' ? w.persoenlichSenden : persoenlichSenden;
  const titel = raum.art === 'dm' ? vonName : raum.name;
  for (const n of ziele) Promise.resolve(senden(w, n, { titel, text, ...(klick ? { klick } : {}), schluessel: `${art}:${raum.id}:${n}` })).catch(() => {});
  return ziele;
}

/** Beginn → Meldungen; Ende → Notiz mit Dauer; verpasst (nur DMs) → Notiz + Meldung an den anderen. */
export async function anrufMelden(w, raum, { art, von, vonName, video = false, dauer_s = 0, aktiv = [] }) {
  if (art === 'beginn') return { benachrichtigt: await pushen(w, raum, { von, vonName, aktiv, text: `${vonName} ruft an`, art: 'anruf' }) };
  if (art === 'ende') return { benachrichtigt: [], nachricht: await systemEintrag(w, raum.id, { art: 'anruf_ende', wer: null, daten: { dauer_s, video } }) };
  if (art === 'verpasst') {
    if (raum.art !== 'dm') throw new FahnasFehler('E_PARAMS', 'Verpasste Anrufe gibt es nur in Direktnachrichten', { feld: 'art' });
    const nachricht = await systemEintrag(w, raum.id, { art: 'anruf_verpasst', wer: von, daten: { video } });
    // verpasst: immer melden (nur „stumm“ zählt) – ein Aufrufer kann die Meldung nicht über `aktiv` unterdrücken
    return { benachrichtigt: await pushen(w, raum, { von, vonName, aktiv: [], text: `Verpasster Anruf von ${vonName}`, art: 'anruf_verpasst' }), nachricht };
  }
  throw new FahnasFehler('E_PARAMS', 'Unbekannte Art', { feld: 'art' });
}

export function registriereAnruf(reg, w) {
  reg.aktion('chat.anruf', {
    rolle: 'nutzer', audit: false, schema: SCHEMA, beschreibung: 'Anruf beginnt, endet oder wurde verpasst (Notiz, Handy-Meldung)',
    ausfuehren: async (p, k) => {
      const raum = await raumFuerNutzer(w, p.raum, k);
      const namen = await nutzerDaten(w);
      return anrufMelden(w, raum, { art: p.art, von: k.nutzer, vonName: anzeigename(namen, k.nutzer), video: p.video, dauer_s: p.dauer_s, aktiv: p.aktiv });
    },
  });
  reg.aktion('chat.gast.anruf', {
    rolle: 'gast', audit: false, schema: { ausweis: S.ausweis, ...SCHEMA }, beschreibung: 'Anruf eines Gasts beginnt oder endet',
    ausfuehren: async (p) => {
      const a = await ausweisPruefen(w, p.ausweis);
      if (p.raum !== a.raum.id) throw new FahnasFehler('E_RECHTE', 'Kein Zugriff auf diesen Raum', { feld: 'raum' });
      if (p.art === 'verpasst') throw new FahnasFehler('E_PARAMS', 'Gäste haben keine verpassten Anrufe', { feld: 'art' });
      return anrufMelden(w, a.raum, { art: p.art, von: `gast:${a.gastId}`, vonName: a.gast.name, video: p.video, dauer_s: p.dauer_s, aktiv: p.aktiv });
    },
  });
  reg.aktion('chat.turn_info', {
    rolle: 'gast', lesend: true, audit: false, schema: {}, beschreibung: 'Auskunft für den TURN-Dienst (LAN-IP, an/aus, Port)',
    ausfuehren: async () => {
      let ip = null;
      try { ({ ip } = await (w.nasNetz ?? nasNetz)(w.system)); } catch { ip = null; }
      const { turn } = await chatEinstellungen(w);
      return { lan_ip: ip || null, aktiv: !!(turn && turn.aktiv), port: (turn && turn.port) || 3478 };
    },
  });
}
