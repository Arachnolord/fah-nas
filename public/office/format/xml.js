// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// XML lesen im Browser (Plan 05, V17) – für docx und xlsx. Liefert einen Baum {name, attribute, kinder, text}: Präfixe
// bleiben im Namen (w:p), `text` ist der direkte Text ohne Kinder und wird NICHT getrimmt (w:t braucht Leerzeichen).
// Sicher gegen fremde Dateien: eine DTD wird übersprungen, nie ausgewertet (keine eigenen oder externen Entitäten –
// unbekannte bleiben wörtlich stehen), höchstens 256 Ebenen. Fehler: Error('xml_kaputt').

const MAX_TIEFE = 256;
const ENTITAETEN = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });
const kaputt = () => new Error('xml_kaputt');

/** In XML 1.0 erlaubtes Zeichen? */
const erlaubt = (cp) => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);

function entitaeten(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*);/g, (ganz, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && erlaubt(cp) ? String.fromCodePoint(cp) : ganz;
    }
    return Object.hasOwn(ENTITAETEN, e) ? ENTITAETEN[e] : ganz;
  });
}

/** Ende eines Tags („>“ außerhalb von Attribut-Anführungszeichen). */
function tagEnde(s, von) {
  let q = null;
  for (let i = von + 1; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return -1;
}

function attributeLesen(text) {
  const aus = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) aus[m[1]] = entitaeten(m[3] !== undefined ? m[3] : m[4]);
  if (text.replace(re, '').trim()) throw kaputt();
  return aus;
}

/** DOCTYPE überspringen (mit internem Teil „[ … ]“) → Index hinter der Deklaration. */
function doctypeEnde(s, lt) {
  const gt = s.indexOf('>', lt);
  const klammer = s.indexOf('[', lt);
  if (klammer >= 0 && (gt < 0 || klammer < gt)) {
    const m = /\]\s*>/g; m.lastIndex = klammer;
    const e = m.exec(s);
    if (!e) throw kaputt();
    return e.index + e[0].length;
  }
  if (gt < 0) throw kaputt();
  return gt + 1;
}

/** XML lesen → Wurzelelement {name, attribute, kinder, text}. */
export function xmlLesen(text) {
  if (typeof text !== 'string') throw kaputt();
  const s = text.replace(/^﻿/, '');
  let i = 0;
  const dok = { name: '#dok', attribute: {}, kinder: [], teile: [] };
  const stapel = [dok];
  const oben = () => stapel[stapel.length - 1];
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { oben().teile.push(s.slice(i)); break; }
    if (lt > i) oben().teile.push(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) throw kaputt(); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); if (e < 0) throw kaputt(); oben().teile.push({ roh: s.slice(lt + 9, e) }); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt + 2); if (e < 0) throw kaputt(); i = e + 2; continue; }
    if (s.startsWith('<!DOCTYPE', lt) || s.startsWith('<!doctype', lt)) { i = doctypeEnde(s, lt); continue; }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); if (e < 0) throw kaputt(); i = e + 1; continue; }
    const gt = tagEnde(s, lt);
    if (gt < 0) throw kaputt();
    const innen = s.slice(lt + 1, gt);
    if (innen.startsWith('/')) {
      const name = innen.slice(1).trim();
      const el = oben();
      if (el === dok || el.name !== name) throw kaputt();
      stapel.pop();
      i = gt + 1;
      continue;
    }
    const selbst = innen.endsWith('/');
    const kopf = (selbst ? innen.slice(0, -1) : innen).trim();
    const m = /^([A-Za-z_][\w.:-]*)([\s\S]*)$/.exec(kopf);
    if (!m) throw kaputt();
    const el = { name: m[1], attribute: attributeLesen(m[2]), kinder: [], teile: [] };
    oben().kinder.push(el);
    if (!selbst) {
      stapel.push(el);
      if (stapel.length - 1 > MAX_TIEFE) throw kaputt();
    }
    i = gt + 1;
  }
  if (stapel.length !== 1) throw kaputt();
  const fertig = (el) => {
    el.text = el.teile.map((t) => (typeof t === 'string' ? entitaeten(t) : t.roh)).join('');
    delete el.teile;
    for (const k of el.kinder) fertig(k);
    return el;
  };
  const wurzel = dok.kinder[0];
  if (!wurzel) throw kaputt();
  return fertig(wurzel);
}

/** Eigener Text und der Text aller Nachfahren (Kinder der Reihe nach). */
export function xmlText(knoten) {
  if (!knoten) return '';
  return (knoten.text || '') + knoten.kinder.map(xmlText).join('');
}

/** Text für XML schützen; Steuerzeichen außer Tab, Zeilenvorschub und Wagenrücklauf fallen weg. */
export function xmlEscape(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function kind(knoten, name) { return (knoten && knoten.kinder.find((k) => k.name === name)) || null; }
export function kinder(knoten, name) { return knoten ? knoten.kinder.filter((k) => k.name === name) : []; }
