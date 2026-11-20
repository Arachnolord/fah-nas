// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sync-Klient (V12) nach Jupiter-Art: höchstens eine eigene Op ist unterwegs, weitere warten im Puffer (zusammengesetzt,
// wo möglich). Fremde Ops vom Server werden gegen die unbestätigte und die gepufferten eigenen Ops transformiert; die
// eigenen gelten dabei als später angekommen (der Server ordnet sie nach den fremden ein). Nach einem Abbruch holt
// „wiederaufnehmen“ die verpassten Ops; die eigene cid darin zählt als Bestätigung.

function zufall8() {
  const z = new Uint8Array(8); globalThis.crypto.getRandomValues(z);
  return [...z].map((b) => (b % 36).toString(36)).join('');
}

export class SyncKlient {
  constructor({ typ, version, daten, senden, cidVorsilbe = zufall8() }) {
    this.typ = typ; this._version = version; this._daten = daten; this._senden = senden; this.vorsilbe = cidVorsilbe;
    this.n = 0; this.gesendet = null; this.puffer = []; this.hoerer = new Map();
  }

  get daten() { return this._daten; }
  get version() { return this._version; }
  get ausstehend() { return (this.gesendet ? 1 : 0) + this.puffer.length; }

  on(art, fn) {
    if (!this.hoerer.has(art)) this.hoerer.set(art, new Set());
    this.hoerer.get(art).add(fn);
    return () => { this.hoerer.get(art)?.delete(fn); };
  }

  _melden(art, daten) { for (const fn of [...(this.hoerer.get(art) || [])]) { try { fn(daten); } catch (e) { console.error(e); } } }

  _hinaus(op, cid = `${this.vorsilbe}-${++this.n}`) {
    this.gesendet = { op, cid };
    this._senden({ art: 'op', basis: this._version, cid, op });
  }

  /** Nächste gepufferte Op senden; durch fremde Ops wirkungslos gewordene fallen weg (der Server nähme sie nicht an). */
  _naechsteSenden() {
    while (this.puffer.length) {
      const op = this.puffer.shift();
      if (this.typ.istNoop(op)) continue;
      this._hinaus(op);
      return;
    }
  }

  /** Eigene Änderung: prüfen, sofort anwenden, senden oder puffern (ohne Wirkung: nichts). */
  lokal(op) {
    this.typ.pruefen(op);
    if (this.typ.istNoop(op)) return;
    this._daten = this.typ.anwenden(this._daten, op);
    this._melden('aenderung', { op, lokal: true });
    if (!this.gesendet) { this._hinaus(op); return; }
    const letzte = this.puffer[this.puffer.length - 1];
    const zusammen = letzte ? this.typ.zusammensetzen(letzte, op) : null;
    if (zusammen) this.puffer[this.puffer.length - 1] = zusammen; else this.puffer.push(op);
  }

  /** Nach dem Wiederverbinden: verpasste Ops ab dem eigenen Stand anfordern. */
  wiederaufnehmen() { this._senden({ art: 'wiederaufnehmen', version: this._version }); }

  /** Nachricht vom Server: op, fehler, wiederaufgenommen, neu_laden. */
  empfangen(n) {
    if (!n || typeof n !== 'object') return;
    if (n.art === 'op') { this._op(n); return; }
    if (n.art === 'fehler') { if (this.gesendet && n.cid === this.gesendet.cid) this._melden('neu_laden', { grund: 'fehler' }); return; }
    if (n.art === 'neu_laden') { this._melden('neu_laden', { grund: n.grund || 'neu_laden' }); return; }
    if (n.art === 'wiederaufgenommen') {
      const offen = this.gesendet;
      for (const e of n.ops || []) this._op({ version: e.v, cid: e.cid, op: e.op });
      if (Number.isInteger(n.version)) this._version = n.version;
      // kam beim Server nie an (nicht bestätigt): mit neuer Basis und gleicher cid noch einmal – eine nach der Bestätigung
      // nachgerückte Op ist dagegen schon mit aktueller Basis unterwegs; ist sie inzwischen wirkungslos, fällt sie weg
      if (offen && this.gesendet === offen) {
        if (this.typ.istNoop(offen.op)) { this.gesendet = null; this._naechsteSenden(); } else this._hinaus(offen.op, offen.cid);
      }
    }
  }

  _op(n) {
    // Server-Versionen steigen streng: Bekanntes (doppelte Bestätigung nach Wiederaufnahme, alte Nachrichten nach Neuladen)
    // nie ein zweites Mal anwenden – sonst spielte eine alte Op einen überholten Stand zurück
    if (Number.isInteger(n.version) && n.version <= this._version) return;
    if (this.gesendet && n.cid === this.gesendet.cid) {
      this._version = n.version; this.gesendet = null;
      this._melden('bestaetigt', { version: this._version });
      this._naechsteSenden();
      return;
    }
    // Fremde Op: gegen Unbestätigtes transformieren (eigene gelten als später) – und das Unbestätigte gegen sie. Eigene, die
    // dabei wirkungslos werden (etwa: ihre Zeile wurde gleichzeitig gelöscht), meldet „verworfen“ – sonst gingen sie still verloren
    let s = n.op;
    const weg = [];
    if (this.gesendet) {
      const vorher = this.gesendet.op;
      const s1 = this.typ.transformiere(s, vorher, 'links');
      this.gesendet.op = this.typ.transformiere(vorher, s, 'rechts');
      if (!this.typ.istNoop(vorher) && this.typ.istNoop(this.gesendet.op)) weg.push(vorher);
      s = s1;
    }
    for (let i = 0; i < this.puffer.length; i++) {
      const p = this.puffer[i];
      const s1 = this.typ.transformiere(s, p, 'links');
      this.puffer[i] = this.typ.transformiere(p, s, 'rechts');
      if (!this.typ.istNoop(p) && this.typ.istNoop(this.puffer[i])) weg.push(p);
      s = s1;
    }
    this._version = n.version;
    if (!this.typ.istNoop(s)) {
      this._daten = this.typ.anwenden(this._daten, s);
      this._melden('aenderung', { op: s, lokal: false });
    }
    if (weg.length) this._melden('verworfen', { ops: weg });
  }
}
