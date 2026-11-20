// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Laufende Anrufe in der Oberfläche (Plan 03): eine Karte Raum → {teilnehmer, beginn} aus den anruf.stand-Meldungen
// des Servers, gemeinsam für Raumkopf, Banner, Kachel und Gastseite. Dazu die Texte der Anruf-Notizen im Verlauf.
// Kein Import aus app.js.

/** anruf.stand auf die Karte anwenden (rein): leere Teilnehmerliste → Eintrag weg; andere Nachrichten → dieselbe Karte. */
export function standAnwenden(karte, nachricht) {
  if (!nachricht || nachricht.art !== 'anruf.stand' || typeof nachricht.raum !== 'string') return karte;
  const neu = new Map(karte);
  if (!Array.isArray(nachricht.teilnehmer) || !nachricht.teilnehmer.length) neu.delete(nachricht.raum);
  else neu.set(nachricht.raum, { raum: nachricht.raum, teilnehmer: nachricht.teilnehmer, beginn: nachricht.beginn ?? null });
  return neu;
}

/** Text einer Anruf-Notiz im Verlauf – oder null, wenn es keine Anruf-Notiz ist. */
export function anrufSystemText(system, t, format) {
  if (!system) return null;
  const d = system.daten && typeof system.daten === 'object' ? system.daten : {};
  if (system.art === 'anruf_ende') {
    const s = Number(d.dauer_s) || 0;
    if (s <= 0) return t('chat.system_anruf_nicht_angenommen');
    return t('chat.system_anruf_ende', { dauer: format && typeof format.dauer === 'function' ? format.dauer(s) : `${s} s` });
  }
  if (system.art === 'anruf_verpasst') return t('chat.system_anruf_verpasst', { name: system.wer_name || '' });
  return null;
}

const staende = new WeakMap(); // Verbindung → Stand

/** Gemeinsamer Anruf-Stand je Verbindung: laufende(), on(fn) → ab, abfragen(). Fragt beim Start und nach „wieder“. */
export function anrufStand(verbindung) {
  if (staende.has(verbindung)) return staende.get(verbindung);
  let karte = new Map(); let wartet = false;
  const hoerer = new Set();
  const melden = () => { for (const fn of [...hoerer]) { try { fn(karte); } catch (e) { console.error(e); } } };
  const stand = {
    laufende: () => karte,
    on(fn) { hoerer.add(fn); return () => { hoerer.delete(fn); }; },
    abfragen() { wartet = !verbindung.senden({ art: 'anruf.abfragen' }); },
  };
  verbindung.on('anruf.stand', (n) => { const neu = standAnwenden(karte, n); if (neu !== karte) { karte = neu; melden(); } });
  verbindung.on('status', (s) => { if (s === 'verbunden' && wartet) stand.abfragen(); });
  verbindung.on('wieder', () => { karte = new Map(); melden(); stand.abfragen(); });
  staende.set(verbindung, stand);
  stand.abfragen();
  return stand;
}
