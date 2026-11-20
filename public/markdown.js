// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigene, sichere Markdown-Darstellung (Vertrag V4): baut den DOM nur mit createElement/createTextNode – HTML im
// Text bleibt Text, Links nur http:, https: und mailto: (rel="noopener noreferrer", target="_blank").
// Modus 'voll' (Texteditor, Office-Kartenbeschreibung): Überschriften, Absätze, Listen samt Aufgaben-Häkchen (nur
// Anzeige), Zitate, Codeblöcke, Tabellen (GFM), Linie, Inline-Formate. Modus 'chat': nur Inline-Formate, Links,
// Codeblöcke und Zeilenumbrüche. Ein einzelner Zeilenumbruch im Absatz wird zu <br> (Notizen bleiben lesbar).

const ERLAUBT = /^(https?:\/\/|mailto:)/i;
const ZAUN = /^\s{0,3}(`{3,}|~{3,})/;
const UEBERSCHRIFT = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LINIE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ZITAT = /^\s{0,3}>\s?/;
const LISTE = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
const AUFGABE = /^\[( |x|X)\]\s+/;
const TRENNER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPEBAR = /[\\`*_{}[\]()#+\-.!~|<>]/;

const neu = (tag) => document.createElement(tag);
const leer = (z) => /^\s*$/.test(z);

/** Link-Ziel prüfen: nur http(s) und mailto, sonst null (die Stelle bleibt dann Text). */
function linkZiel(url) {
  const u = String(url).trim().replace(/^<(.*)>$/, '$1');
  return ERLAUBT.test(u) ? u : null;
}

function link(url, kinderText) {
  const a = neu('a');
  a.setAttribute('href', url);
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('target', '_blank');
  if (typeof kinderText === 'string') a.appendChild(document.createTextNode(kinderText));
  return a;
}

/** Schließendes Trennzeichen `d` ab Position `ab` (nicht escaped); -1 wenn keins. */
function schluss(text, d, ab) {
  for (let j = text.indexOf(d, ab); j !== -1; j = text.indexOf(d, j + 1)) {
    if (text[j - 1] !== '\\') return j;
  }
  return -1;
}

/** Inline-Teile (Formate, Code, Links, Autolinks, Zeilenumbrüche) als Kinder an `ziel` hängen. */
function inline(text, ziel) {
  let puffer = '';
  const raus = () => { if (puffer) { ziel.appendChild(document.createTextNode(puffer)); puffer = ''; } };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && ESCAPEBAR.test(text[i + 1])) { puffer += text[i + 1]; i += 2; continue; }
    if (c === '\n') { raus(); ziel.appendChild(neu('br')); i++; continue; }
    if (c === '`') {
      let n = 0; while (text[i + n] === '`') n++;
      const zu = text.indexOf('`'.repeat(n), i + n);
      if (zu !== -1) {
        raus();
        const code = neu('code');
        let innen = text.slice(i + n, zu);
        if (innen.length > 1 && innen.startsWith(' ') && innen.endsWith(' ')) innen = innen.slice(1, -1);
        code.textContent = innen;
        ziel.appendChild(code);
        i = zu + n; continue;
      }
      puffer += '`'.repeat(n); i += n; continue;
    }
    const doppel = text.slice(i, i + 2);
    if (doppel === '**' || doppel === '__' || doppel === '~~') {
      const zu = schluss(text, doppel, i + 2);
      if (zu > i + 2) {
        raus();
        const e = neu(doppel === '~~' ? 'del' : 'strong');
        inline(text.slice(i + 2, zu), e);
        ziel.appendChild(e);
        i = zu + 2; continue;
      }
    }
    if (c === '*' || c === '_') {
      const vorne = i > 0 ? text[i - 1] : ' ';
      const zu = schluss(text, c, i + 1);
      const ok = zu > i + 1 && !/\s/.test(text[i + 1]) && !/\s/.test(text[zu - 1])
        && (c === '*' || (!/[A-Za-z0-9]/.test(vorne) && !/[A-Za-z0-9]/.test(text[zu + 1] || ' ')));
      if (ok) {
        raus();
        const e = neu('em');
        inline(text.slice(i + 1, zu), e);
        ziel.appendChild(e);
        i = zu + 1; continue;
      }
    }
    if (c === '[') {
      const zuText = schluss(text, ']', i + 1);
      if (zuText !== -1 && text[zuText + 1] === '(') {
        // passende Klammer suchen (Klammern im Ziel sind erlaubt, z. B. javascript:alert(1))
        let tiefe = 0; let k = zuText + 1;
        for (; k < text.length; k++) { if (text[k] === '(') tiefe++; else if (text[k] === ')') { tiefe--; if (tiefe === 0) break; } }
        if (k < text.length) {
          const ziel2 = linkZiel(text.slice(zuText + 2, k).replace(/\s+"[^"]*"\s*$/, ''));
          if (ziel2) {
            raus();
            const a = link(ziel2);
            inline(text.slice(i + 1, zuText), a);
            ziel.appendChild(a);
          } else {
            puffer += text.slice(i, k + 1); // unsicheres Ziel: die ganze Stelle bleibt Text
          }
          i = k + 1; continue;
        }
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(text.slice(i));
      if (m) { raus(); ziel.appendChild(link(m[1], m[1])); i += m[0].length; continue; }
    }
    if ((c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const m = /^https?:\/\/[^\s<]+/i.exec(text.slice(i));
      if (m) {
        let url = m[0];
        // Satzzeichen am Ende gehören zum Satz, nicht zur Adresse; „)“ nur, wenn keine offene Klammer in der Adresse
        for (;;) {
          const letzt = url[url.length - 1];
          if (/[.,;:!?]/.test(letzt)) { url = url.slice(0, -1); continue; }
          if (letzt === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) { url = url.slice(0, -1); continue; }
          break;
        }
        raus(); ziel.appendChild(link(url, url)); i += url.length; continue;
      }
    }
    puffer += c; i++;
  }
  raus();
}

/** Zellen einer Tabellenzeile (äußere | weg, an nicht escapten | trennen). */
function zellen(zeile) {
  let z = zeile.trim();
  if (z.startsWith('|')) z = z.slice(1);
  if (z.endsWith('|') && !z.endsWith('\\|')) z = z.slice(0, -1);
  const aus = []; let teil = '';
  for (let i = 0; i < z.length; i++) {
    if (z[i] === '\\' && z[i + 1] === '|') { teil += '|'; i++; continue; }
    if (z[i] === '|') { aus.push(teil.trim()); teil = ''; continue; }
    teil += z[i];
  }
  aus.push(teil.trim());
  return aus;
}

function istTabellenstart(zeilen, i) {
  return zeilen[i].includes('|') && i + 1 < zeilen.length && zeilen[i + 1].includes('-') && TRENNER.test(zeilen[i + 1]) && zeilen[i + 1].includes('|');
}

/** Beginnt mit dieser Zeile ein anderer Block (beendet einen Absatz)? */
function blockStart(zeilen, i, chat) {
  const z = zeilen[i];
  if (ZAUN.test(z)) return true;
  if (chat) return false;
  return UEBERSCHRIFT.test(z) || LINIE.test(z) || ZITAT.test(z) || LISTE.test(z) || istTabellenstart(zeilen, i);
}

/** Liste ab Zeile i; gibt die nächste ungelesene Zeile zurück. */
function liste(zeilen, i, ziel) {
  const m0 = LISTE.exec(zeilen[i]);
  const einzug0 = m0[1].length;
  const geordnet = /\d/.test(m0[2]);
  const el = neu(geordnet ? 'ol' : 'ul');
  if (geordnet) { const start = parseInt(m0[2], 10); if (start !== 1) el.setAttribute('start', String(start)); }
  while (i < zeilen.length) {
    if (leer(zeilen[i])) {
      // Leerzeilen zwischen Punkten derselben Liste überspringen
      let j = i; while (j < zeilen.length && leer(zeilen[j])) j++;
      const mj = j < zeilen.length ? LISTE.exec(zeilen[j]) : null;
      if (mj && mj[1].length === einzug0 && /\d/.test(mj[2]) === geordnet) { i = j; continue; }
      break;
    }
    const m = LISTE.exec(zeilen[i]);
    if (!m || m[1].length !== einzug0 || /\d/.test(m[2]) !== geordnet) break;
    const versatz = m[0].length;
    let inhalt = zeilen[i].slice(versatz);
    i++;
    const unter = [];
    while (i < zeilen.length && !leer(zeilen[i])) {
      const einzug = zeilen[i].match(/^\s*/)[0].length;
      if (einzug <= einzug0) break;
      unter.push(zeilen[i].slice(Math.min(einzug, versatz)));
      i++;
    }
    const li = neu('li');
    const aufgabe = AUFGABE.exec(inhalt);
    if (aufgabe) {
      const kasten = neu('input');
      kasten.setAttribute('type', 'checkbox');
      if (aufgabe[1] !== ' ') kasten.setAttribute('checked', '');
      kasten.setAttribute('disabled', '');
      li.appendChild(kasten);
      inhalt = inhalt.slice(aufgabe[0].length);
    }
    inline(inhalt, li);
    if (unter.length) bloecke(unter, li, false);
    el.appendChild(li);
  }
  ziel.appendChild(el);
  return i;
}

function tabelle(zeilen, i, ziel) {
  const t = neu('table');
  const kopf = neu('thead'); const kz = neu('tr');
  for (const z of zellen(zeilen[i])) { const th = neu('th'); inline(z, th); kz.appendChild(th); }
  kopf.appendChild(kz); t.appendChild(kopf);
  i += 2;
  const rumpf = neu('tbody');
  while (i < zeilen.length && !leer(zeilen[i]) && zeilen[i].includes('|')) {
    const tr = neu('tr');
    for (const z of zellen(zeilen[i])) { const td = neu('td'); inline(z, td); tr.appendChild(td); }
    rumpf.appendChild(tr); i++;
  }
  if (rumpf.childNodes.length) t.appendChild(rumpf);
  ziel.appendChild(t);
  return i;
}

/** Blöcke aus Zeilen an `ziel` hängen. */
function bloecke(zeilen, ziel, chat) {
  let i = 0;
  while (i < zeilen.length) {
    const z = zeilen[i];
    if (leer(z)) { i++; continue; }
    const zaun = ZAUN.exec(z);
    if (zaun) {
      const inhalt = []; i++;
      while (i < zeilen.length && !zeilen[i].trim().startsWith(zaun[1])) { inhalt.push(zeilen[i]); i++; }
      i++; // schließender Zaun (fehlt er, endet der Block am Textende)
      const pre = neu('pre'); const code = neu('code');
      code.textContent = inhalt.join('\n');
      pre.appendChild(code); ziel.appendChild(pre);
      continue;
    }
    if (!chat) {
      const ue = UEBERSCHRIFT.exec(z);
      if (ue) { const h = neu(`h${ue[1].length}`); inline(ue[2], h); ziel.appendChild(h); i++; continue; }
      if (LINIE.test(z)) { ziel.appendChild(neu('hr')); i++; continue; }
      if (ZITAT.test(z)) {
        const innen = [];
        while (i < zeilen.length && ZITAT.test(zeilen[i])) { innen.push(zeilen[i].replace(ZITAT, '')); i++; }
        const bq = neu('blockquote'); bloecke(innen, bq, false); ziel.appendChild(bq);
        continue;
      }
      if (LISTE.test(z)) { i = liste(zeilen, i, ziel); continue; }
      if (istTabellenstart(zeilen, i)) { i = tabelle(zeilen, i, ziel); continue; }
    }
    const absatz = [z]; i++;
    while (i < zeilen.length && !leer(zeilen[i]) && !blockStart(zeilen, i, chat)) { absatz.push(zeilen[i]); i++; }
    const p = neu('p'); inline(absatz.join('\n'), p); ziel.appendChild(p);
  }
}

/** Markdown-Text → DocumentFragment (V4). `modus`: 'voll' | 'chat'. */
export function markdownZuKnoten(text, { modus = 'voll' } = {}) {
  const frag = document.createDocumentFragment();
  const zeilen = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  bloecke(zeilen, frag, modus === 'chat');
  return frag;
}
