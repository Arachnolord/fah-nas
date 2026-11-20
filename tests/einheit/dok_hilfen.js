// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Testhilfen für den Dokument-Editor (Plan 05, Aufgaben 11–15): getSelection-Attrappe, Schein-Sitzung nach V18 und
// Einbinden in die DOM-Attrappe. Keine Testdatei (kein .test.js).

/** getSelection-Attrappe: Anker/Fokus, setBaseAndExtent; ersetzt globalThis.getSelection. */
export function auswahlAttrappe() {
  const s = {
    anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, rangeCount: 0,
    get isCollapsed() { return this.anchorNode === this.focusNode && this.anchorOffset === this.focusOffset; },
    setze(knoten, offset, fKnoten = knoten, fOffset = offset) {
      Object.assign(this, { anchorNode: knoten, anchorOffset: offset, focusNode: fKnoten, focusOffset: fOffset, rangeCount: 1 });
    },
    setBaseAndExtent(a, ao, f, fo) { this.setze(a, ao, f, fo); },
    removeAllRanges() { Object.assign(this, { anchorNode: null, focusNode: null, rangeCount: 0 }); },
  };
  globalThis.getSelection = () => s;
  return s;
}

/** Schein-Sitzung: lokal prüft, wendet an und meldet; fremd meldet als fremde Änderung; emit für recht usw. */
export function schein(dokument, delta, recht = 'bearbeiten') {
  const hoerer = new Map();
  const s = {
    daten: { delta, kommentare: {} }, dok: { id: 'oX', name: 'Bericht', besitzer: 'anna', art: 'dokument' }, recht, ops: [], gesendet: [],
    on(art, fn) { if (!hoerer.has(art)) hoerer.set(art, new Set()); hoerer.get(art).add(fn); return () => hoerer.get(art).delete(fn); },
    emit(art, x) { for (const fn of [...(hoerer.get(art) || [])]) fn(x); },
    lokal(op) {
      if (s.recht !== 'bearbeiten') throw new Error('E_RECHTE');
      dokument.pruefen(op);
      s.daten = dokument.anwenden(s.daten, op); s.ops.push(op); s.emit('aenderung', { op, lokal: true });
    },
    fremd(op) { s.daten = dokument.anwenden(s.daten, op); s.emit('aenderung', { op, lokal: false }); },
    auswahlSenden(aw) { s.gesendet.push(aw); },
    dateiUrl: (d) => `/d/${d}`,
  };
  return s;
}

/** Editor in einen frischen Behälter einbinden; ctx sammelt Meldungen und Fehler, `ctxExtra` ergänzt (z. B. eingabe). */
export async function einbinden(editorEinbinden, s, ctxExtra = {}) {
  const behaelter = document.createElement('div'); document.body.appendChild(behaelter);
  const meldungen = []; const fehler = [];
  const ctx = { melden: (...a) => meldungen.push(a), zeigeFehler: (e) => fehler.push(e), nutzer: { name: 'anna' }, ...ctxExtra };
  const editor = await editorEinbinden(behaelter, { ctx, sitzung: s, recht: s.recht });
  const wurzel = behaelter.querySelector('.od-text');
  wurzel.focus();
  return { behaelter, wurzel, editor, meldungen, fehler, ctx };
}
