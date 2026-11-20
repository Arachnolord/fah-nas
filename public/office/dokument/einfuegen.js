// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einfügen ins Office-Dokument (Plan 05): Fremd-HTML aus Word, Google Docs und Webseiten wird zu einem sauberen Delta
// (nur bekannte Formate, Links nur http/https/mailto, nichts Ausführbares, Tabellen als Embed), Klartext wird zu Zeilen,
// und das Eingefügte ersetzt die Auswahl. Das HTML wird nur gelesen, nie ins Dokument der Seite gehängt.

import { normalisieren, laenge } from '../../gemeinsam/sync/delta.js';
import { FARBEN, HINTERGRUENDE, ZEILEN_ATTRIBUTE, farbeNormal, linkErlaubt, neueId } from '../../gemeinsam/sync/typen/dokument-attribute.js';
import { zellKey, GRENZEN as TABELLE } from '../../gemeinsam/sync/typen/dokument-tabelle.js';

/** Größeres HTML wird nicht geparst, dann zählt der Klartext. */
export const HTML_MAX = 2_097_152;

const IGNORIERT = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg', 'math', 'head', 'img', 'video', 'audio', 'input', 'button', 'select', 'textarea']);
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'tr', 'td', 'th', 'ul', 'ol', 'dl', 'dt', 'dd',
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'figure', 'figcaption', 'address', 'hr', 'caption', 'details', 'summary', 'table']);
const UEBERSCHRIFT = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 };
const KLASSEN_INLINE = new Map([['od-f', 'fett'], ['od-k', 'kursiv'], ['od-u', 'unterstrichen'], ['od-s', 'durchgestrichen'], ['od-code', 'code']]);
const STEUER = /[\u0000-\u0008\u000e-\u001f\u007f￼]/g; // ohne \t \n \v \f \r
const LEERRAUM = /[ \t\n\v\f]+/g;
const PAPIER = '#ffffff';
const SCHRIFT = '#1c1c1c';

const kinderVon = (k) => Array.prototype.slice.call(k.childNodes || []);
const klassenVon = (e) => (e.getAttribute('class') || '').split(/\s+/).filter(Boolean);

function kanal(hex) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); }
function leuchtdichte(hex) {
  const f = (x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = kanal(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function kontrast(a, b) {
  const l1 = leuchtdichte(a); const l2 = leuchtdichte(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Inline-Stil lesen → {setzen, entfernen}. Schrift fast schwarz (alle Kanäle < 0x40) ist die Standardfarbe und fällt weg,
 * ebenso Schrift, die auf dem weißen Papier unlesbar wäre; Hintergrund transparent, weiß oder zu dunkel für schwarze
 * Schrift fällt weg.
 */
function stilAuswerten(stil) {
  const setzen = {}; const entfernen = [];
  for (const teil of String(stil || '').split(';')) {
    const i = teil.indexOf(':');
    if (i < 0) continue;
    const k = teil.slice(0, i).trim().toLowerCase();
    const v = teil.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, '');
    if (k === 'font-weight') {
      const g = v === 'bold' || v === 'bolder' ? 700 : v === 'normal' || v === 'lighter' ? 400 : Number.parseInt(v, 10);
      if (g >= 600) setzen.fett = true; else if (Number.isFinite(g)) entfernen.push('fett');
    } else if (k === 'font-style') {
      if (v === 'italic' || v === 'oblique') setzen.kursiv = true; else if (v === 'normal') entfernen.push('kursiv');
    } else if (k === 'text-decoration' || k === 'text-decoration-line') {
      if (v.includes('underline')) setzen.unterstrichen = true;
      if (v.includes('line-through')) setzen.durchgestrichen = true;
      if (v === 'none') entfernen.push('unterstrichen', 'durchgestrichen');
    } else if (k === 'color') {
      const f = farbeNormal(v, FARBEN);
      if (f) {
        const hex = Object.hasOwn(FARBEN, f) ? FARBEN[f] : f;
        if (!kanal(hex).every((x) => x < 0x40) && kontrast(hex, PAPIER) >= 3) setzen.farbe = f;
      }
    } else if (k === 'background-color' || k === 'background') {
      const f = farbeNormal(v, HINTERGRUENDE);
      if (f) {
        const hex = Object.hasOwn(HINTERGRUENDE, f) ? HINTERGRUENDE[f] : f;
        if (hex !== PAPIER && kontrast(SCHRIFT, hex) >= 4.5) setzen.hintergrund = f;
      }
    }
  }
  return { setzen, entfernen };
}

/** Inline-Formate aus einem style-Attribut (nur, was gesetzt wird). */
export function stilLesen(style) { return stilAuswerten(style).setzen; }

/** Ausrichtung aus style bzw. align: 'mitte' | 'rechts' | 'block' | 'links' (= keine) | null. */
function ausrichtungAus(e) {
  const m = /(?:^|;)\s*text-align\s*:\s*([a-z-]+)/i.exec(e.getAttribute('style') || '');
  const w = (m ? m[1] : e.getAttribute('align') || '').toLowerCase();
  if (w === 'center') return 'mitte';
  if (w === 'right' || w === 'end') return 'rechts';
  if (w === 'justify') return 'block';
  if (w === 'left' || w === 'start') return 'links';
  return null;
}

function versteckt(e) { return /(?:^|;)\s*(?:display\s*:\s*none|mso-hide\s*:\s*all|mso-list\s*:\s*ignore)/i.test(e.getAttribute('style') || ''); }

/** Text des Word-Aufzählungszeichens (span mit mso-list:Ignore) in einem Listenabsatz. */
function msoMarke(e) {
  for (const c of kinderVon(e)) {
    if (c.nodeType !== 1) continue;
    if (/mso-list\s*:\s*ignore/i.test(c.getAttribute('style') || '')) return c.textContent || '';
    const m = msoMarke(c);
    if (m) return m;
  }
  return '';
}

function zeilenNur(attr) {
  const aus = {};
  for (const k of ZEILEN_ATTRIBUTE) if (attr && attr[k] !== undefined && attr[k] !== null && attr[k] !== false) aus[k] = attr[k];
  return aus;
}

/** Häkchen einer Aufgabe im li (nicht in eingebetteten Listen). */
function hakenIn(li) {
  for (const c of kinderVon(li)) {
    if (c.nodeType !== 1 || c.localName === 'ul' || c.localName === 'ol') continue;
    if (c.localName === 'input' && (c.getAttribute('type') || '').toLowerCase() === 'checkbox') return c;
    const f = hakenIn(c);
    if (f) return f;
  }
  return null;
}

/** Sammelt die Teiländerungen; schließt Zeilen, kürzt Leerraum wie ein Browser. */
class Bau {
  constructor(zelle = false) { this.ops = []; this.offen = false; this.leerAmEnde = false; this.zelle = zelle; }

  lauf(text, inline, leerAmEnde) {
    if (!text) return;
    this.ops.push(Object.keys(inline).length ? { insert: text, attributes: { ...inline } } : { insert: text });
    this.offen = true; this.leerAmEnde = leerAmEnde;
  }

  embed(wert) { this.ops.push({ insert: wert }); this.offen = true; this.leerAmEnde = false; }

  /** Zeile schließen, wenn sie Inhalt hat (bzw. immer bei `erzwingen`, z. B. br). */
  zeilenende(attr, erzwingen = false) {
    if (!this.offen && !erzwingen) return;
    if (this.leerAmEnde) {
      const l = this.ops[this.ops.length - 1];
      if (l && typeof l.insert === 'string' && l.insert.endsWith(' ')) { l.insert = l.insert.slice(0, -1); if (!l.insert) this.ops.pop(); }
    }
    const z = this.zelle ? {} : zeilenNur(attr);
    this.ops.push(Object.keys(z).length ? { insert: '\n', attributes: z } : { insert: '\n' });
    this.offen = false; this.leerAmEnde = false;
  }

  text(roh, inline, block) {
    const s = String(roh).replace(/\r\n?/g, '\n').replace(STEUER, '');
    if (block.pre) {
      s.split('\n').forEach((teil, i) => {
        if (i > 0) this.zeilenende(block, true);
        this.lauf(teil.replace(/[\v\f]/g, ' ').replace(/ /g, ' '), inline, false);
      });
      return;
    }
    let t = s.replace(LEERRAUM, ' ');
    if (!this.offen || this.leerAmEnde) t = t.replace(/^ /, '');
    if (!t) return;
    this.lauf(t.replace(/ /g, ' '), inline, t.endsWith(' '));
  }
}

function blockKontext(e, n, block, klassen) {
  const b = { ...block };
  if (n === 'ul' || n === 'ol') { b.tiefe = (block.tiefe || 0) + 1; b.listenArt = n === 'ol' ? 'zahlen' : 'punkte'; }
  if (UEBERSCHRIFT[n]) b.ueberschrift = UEBERSCHRIFT[n];
  if (n === 'blockquote') b.zitat = true;
  if (n === 'pre') b.pre = true;
  if (n === 'li') {
    const haken = hakenIn(e);
    b.liste = haken ? 'aufgabe' : (block.listenArt || 'punkte');
    if (haken && haken.hasAttribute('checked')) b.erledigt = true; else delete b.erledigt;
    const ebene = Math.min(8, Math.max(0, (block.tiefe || 1) - 1));
    if (ebene) b.einzug = ebene; else delete b.einzug;
  }
  // Listen aus Word: Absätze mit mso-list (Ebene aus „levelN“, Zahlen oder Punkte nach dem Aufzählungszeichen)
  const mso = /mso-list\s*:\s*l\d+\s+level(\d+)/i.exec(e.getAttribute('style') || '');
  if (mso) {
    b.liste = /^\s*(\d+|[a-z]{1,4})[.)]/i.test(msoMarke(e)) ? 'zahlen' : 'punkte';
    delete b.erledigt;
    const ebene = Math.min(8, Math.max(0, Number(mso[1]) - 1));
    if (ebene) b.einzug = ebene; else delete b.einzug;
  }
  // eigene Zeilen-Klassen (Kopieren innerhalb des Office)
  for (const k of klassen) {
    let m;
    if ((m = /^od-u([123])$/.exec(k))) b.ueberschrift = Number(m[1]);
    else if (k === 'od-zitat') b.zitat = true;
    else if ((m = /^od-liste-(punkte|zahlen|aufgabe)$/.exec(k))) b.liste = m[1];
    else if ((m = /^od-einzug-([1-8])$/.exec(k))) b.einzug = Number(m[1]);
    else if ((m = /^od-ausr-(mitte|rechts|block)$/.exec(k))) b.ausrichtung = m[1];
    else if (k === 'od-erledigt') b.erledigt = true;
  }
  const ausr = ausrichtungAus(e);
  if (ausr === 'links') delete b.ausrichtung; else if (ausr) b.ausrichtung = ausr;
  return b;
}

function inlineKontext(e, n, inline, block, klassen) {
  const a = { ...inline };
  if (n === 'b' || n === 'strong') a.fett = true;
  else if (n === 'i' || n === 'em') a.kursiv = true;
  else if (n === 'u' || n === 'ins') a.unterstrichen = true;
  else if (n === 's' || n === 'strike' || n === 'del') a.durchgestrichen = true;
  else if (n === 'code' || n === 'kbd' || n === 'samp') a.code = true;
  else if (n === 'a') { const h = e.getAttribute('href'); if (linkErlaubt(h)) a.link = h; }
  if (block.pre) a.code = true;
  const stil = e.getAttribute('style');
  if (stil) {
    const { setzen, entfernen } = stilAuswerten(stil);
    for (const k of entfernen) delete a[k];
    Object.assign(a, setzen);
  }
  for (const k of klassen) {
    if (KLASSEN_INLINE.has(k)) a[KLASSEN_INLINE.get(k)] = true;
    else if (k.startsWith('od-farbe-') && Object.hasOwn(FARBEN, k.slice(9))) a.farbe = k.slice(9);
    else if (k.startsWith('od-hg-') && Object.hasOwn(HINTERGRUENDE, k.slice(6))) a.hintergrund = k.slice(6);
  }
  return a;
}

function gehe(bau, knoten, inline, block) {
  for (const k of kinderVon(knoten)) {
    if (k.nodeType === 3) bau.text(k.data, inline, block);
    else if (k.nodeType === 1) element(bau, k, inline, block);
  }
}

function element(bau, e, inline, block) {
  const n = e.localName;
  if (IGNORIERT.has(n) || versteckt(e)) return;
  if (n === 'br') { bau.zeilenende(block, true); return; }
  const klassen = klassenVon(e);
  if (klassen.includes('od-seitenumbruch')) {
    if (!bau.zelle) { bau.zeilenende(block); bau.embed({ seitenumbruch: true }); bau.zeilenende({}, true); }
    return;
  }
  if (n === 'table' && !bau.zelle) {
    bau.zeilenende(block);
    const t = tabelleAus(e, inline);
    if (t) { bau.embed({ tabelle: t }); bau.zeilenende({}, true); }
    return;
  }
  const istBlock = BLOCK.has(n);
  let b = block;
  if (istBlock) { bau.zeilenende(block); b = blockKontext(e, n, block, klassen); }
  gehe(bau, e, inlineKontext(e, n, inline, b, klassen), b);
  if (istBlock) bau.zeilenende(b);
}

/** Zellinhalt: nur Text mit Inline-Formaten, Absätze als \n, ohne \n am Anfang und Ende, höchstens zelltext Zeichen. */
function zellDelta(td, inline) {
  const bau = new Bau(true);
  gehe(bau, td, inline, {});
  const ops = normalisieren(bau.ops).filter((op) => typeof op.insert === 'string');
  while (ops.length && /^\n/.test(ops[0].insert)) { ops[0] = { ...ops[0], insert: ops[0].insert.replace(/^\n+/, '') }; if (!ops[0].insert) ops.shift(); }
  while (ops.length && /\n$/.test(ops[ops.length - 1].insert)) {
    const l = ops.length - 1;
    ops[l] = { ...ops[l], insert: ops[l].insert.replace(/\n+$/, '') };
    if (!ops[l].insert) ops.pop();
  }
  let rest = TABELLE.zelltext;
  const aus = [];
  for (const op of ops) {
    if (rest <= 0) break;
    const text = op.insert.slice(0, rest);
    rest -= text.length;
    aus.push({ ...op, insert: text });
  }
  return normalisieren(aus);
}

/** HTML-Tabelle → Tabellen-Wert (neue Kennungen) oder null, wenn sie keine Zelle hat. */
function tabelleAus(table, inline) {
  const trs = [];
  const sammle = (k) => {
    for (const c of kinderVon(k)) {
      if (c.nodeType !== 1) continue;
      if (c.localName === 'tr') trs.push(c);
      else if (c.localName === 'thead' || c.localName === 'tbody' || c.localName === 'tfoot') sammle(c);
    }
  };
  sammle(table);
  const roh = [];
  for (const tr of trs.slice(0, TABELLE.zeilen)) {
    const zellen = [];
    for (const c of kinderVon(tr)) {
      if (c.nodeType !== 1 || (c.localName !== 'td' && c.localName !== 'th')) continue;
      zellen.push(zellDelta(c, c.localName === 'th' ? { ...inline, fett: true } : inline));
      const breit = Number.parseInt(c.getAttribute('colspan') || '1', 10);
      for (let i = 1; i < Math.min(Number.isFinite(breit) ? breit : 1, TABELLE.spalten); i++) zellen.push([]);
    }
    roh.push(zellen);
  }
  const breite = Math.min(TABELLE.spalten, roh.reduce((m, z) => Math.max(m, z.length), 0));
  if (!roh.length || !breite) return null;
  const vergeben = new Set();
  const id = () => { let x; do x = neueId(); while (vergeben.has(x)); vergeben.add(x); return x; };
  const zeilen = roh.map(() => id());
  const spalten = Array.from({ length: breite }, () => id());
  const zellen = {};
  roh.forEach((z, i) => z.slice(0, breite).forEach((d, j) => { if (d.length) zellen[zellKey(zeilen[i], spalten[j])] = d; }));
  return { id: id(), zeilen, spalten, weg: [], zellen, breiten: {} };
}

/** HTML (z. B. body aus DOMParser) → Delta, jede Zeile endet mit \n; nichts Sichtbares → []. */
export function htmlZuDelta(wurzel) {
  const bau = new Bau(false);
  gehe(bau, wurzel, {}, {});
  bau.zeilenende({});
  return normalisieren(bau.ops);
}

/** Klartext → Delta: Zeilen bekommen `zeilenAttr`, die letzte Zeile kein \n. Steuerzeichen fallen weg. */
export function textZuDelta(text, zeilenAttr = {}) {
  const attr = zeilenNur(zeilenAttr);
  const zeilen = String(text ?? '').replace(/\r\n?|[\v\f]/g, '\n').replace(STEUER, '').split('\n');
  const ops = [];
  zeilen.forEach((z, i) => {
    if (z) ops.push({ insert: z });
    if (i < zeilen.length - 1) ops.push(Object.keys(attr).length ? { insert: '\n', attributes: { ...attr } } : { insert: '\n' });
  });
  return normalisieren(ops);
}

/** Eingefügtes ersetzt die Auswahl (das letzte \n des Dokuments bleibt) → {delta, cursor}. */
export function einfuegenDelta(daten, aw, eingefuegt) {
  const ende = Math.max(0, laenge(daten.delta) - 1);
  const von = Math.max(0, Math.min(aw.anker, aw.kopf, ende));
  const bis = Math.max(von, Math.min(Math.max(aw.anker, aw.kopf), ende));
  const ops = [{ retain: von }, ...eingefuegt];
  if (bis > von) ops.push({ delete: bis - von });
  return { delta: normalisieren(ops), cursor: von + laenge(eingefuegt) };
}

function bilderAus(dt) {
  let dateien = dt.files ? Array.from(dt.files) : [];
  if (!dateien.length && dt.items) dateien = Array.from(dt.items).filter((i) => i && i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  return dateien.filter((d) => typeof d.type === 'string' && d.type.startsWith('image/'));
}

/**
 * Was aus der Zwischenablage (bzw. beim Ablegen) genommen wird: HTML mit Text oder Tabelle zuerst (Excel und Word legen
 * daneben ein Bild der Auswahl ab), dann Bilddateien, dann Klartext; HTML über HTML_MAX Zeichen wird nicht geparst.
 */
export function zwischenablageLesen(dt) {
  if (!dt) return null;
  const lies = (typ) => { try { return typeof dt.getData === 'function' ? dt.getData(typ) || '' : ''; } catch { return ''; } };
  const html = lies('text/html');
  const text = lies('text/plain');
  let wurzel = null;
  if (html && html.length <= HTML_MAX && typeof DOMParser === 'function') {
    wurzel = new DOMParser().parseFromString(html, 'text/html').body;
  }
  if (wurzel && ((wurzel.textContent || '').trim() || wurzel.querySelector('table'))) return { art: 'html', wurzel };
  const bilder = bilderAus(dt);
  if (bilder.length) return { art: 'dateien', dateien: bilder };
  if (text) return { art: 'text', text };
  return null;
}
