// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Markdown-Export des Office-Dokuments (Plan 05): Absätze, Überschriften, Zitate, Listen (Zahlen, Punkte, Aufgaben,
// 4 Leerzeichen je Ebene), fett/kursiv/durchgestrichen/Code/Links, Bilder, Seitenumbrüche als `---` und Tabellen (die
// erste Zeile ist der Kopf). Was Markdown nicht kennt (Unterstrichen, Farben, Hervorhebung, Kommentare, Ausrichtung),
// entfällt. Text wird so maskiert, dass er nicht als Markdown gelesen wird.

import { zeilenAus } from './modell.js';
import { zellKey, sichtbareZeilen, sichtbareSpalten } from '../../gemeinsam/sync/typen/dokument-tabelle.js';

const ESCAPE = /[\\`*_[\]<>]/g;
const MARKE = { fett: '**', kursiv: '*', durchgestrichen: '~~' };
const ID_LAENGE = 13; // Datei-Kennung „xxxxxxxxxxxx-“ vor dem Namen

const esc = (s) => s.replace(ESCAPE, '\\$&');
const urlSicher = (u) => String(u).replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

/** Am Zeilenanfang würde sonst eine Überschrift, ein Zitat, eine Liste oder eine Nummer daraus. */
function zeilenanfang(s) {
  if (/^[#>+-]/.test(s)) return `\\${s}`;
  const m = /^(\d+)\./.exec(s);
  return m ? `${m[1]}\\.${s.slice(m[0].length)}` : s;
}

function bildMd(wert) {
  const datei = String(wert.datei || '');
  const name = datei.length > ID_LAENGE ? datei.slice(ID_LAENGE) : datei;
  return `![${esc(String(wert.alt || ''))}](${urlSicher(encodeURI(name))})`;
}

/** Marker eines Laufs von außen nach innen (Code kommt gesondert, ganz innen). */
function markenVon(a) {
  const m = [];
  if (!a) return m;
  if (typeof a.link === 'string') m.push(['link', a.link]);
  for (const art of ['fett', 'kursiv', 'durchgestrichen']) if (a[art]) m.push([art]);
  return m;
}

/**
 * Läufe einer Zeile (bzw. Zelle) als Markdown. Gemeinsame Marker benachbarter Läufe bleiben offen; Leerraum am Rand
 * eines Laufs steht außerhalb der Marker.
 */
function inlineMd(ops, { zelle = false } = {}) {
  let aus = ''; let rest = '';
  const offen = [];
  const schliessen = (bis) => {
    while (offen.length > bis) {
      const [art, wert] = offen.pop();
      aus += art === 'link' ? `](${urlSicher(wert)})` : MARKE[art];
    }
  };
  for (const op of ops || []) {
    if (typeof op.insert !== 'string') {
      schliessen(0); aus += rest; rest = '';
      if (op.insert && op.insert.bild) aus += bildMd(op.insert.bild);
      continue;
    }
    const text = zelle ? op.insert.replace(/\n/g, ' ') : op.insert;
    const [, vor, kern, nach] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!kern) { rest += text; continue; }
    const ziel = markenVon(op.attributes);
    let gemeinsam = 0;
    while (gemeinsam < offen.length && gemeinsam < ziel.length && offen[gemeinsam][0] === ziel[gemeinsam][0] && offen[gemeinsam][1] === ziel[gemeinsam][1]) gemeinsam++;
    schliessen(gemeinsam);
    aus += rest + vor; rest = '';
    for (const mk of ziel.slice(gemeinsam)) { aus += mk[0] === 'link' ? '[' : MARKE[mk[0]]; offen.push(mk); }
    if (op.attributes && op.attributes.code) {
      const zaun = kern.includes('`') ? '``' : '`';
      const rand = kern.startsWith('`') || kern.endsWith('`') ? ' ' : '';
      const inhalt = zelle ? kern.replace(/\|/g, '\\|') : kern;
      aus += zaun + rand + inhalt + rand + zaun;
    } else {
      const e = esc(kern);
      aus += zelle ? e.replace(/\|/g, '\\|') : e;
    }
    rest = nach;
  }
  schliessen(0);
  return aus + rest;
}

function tabelleMd(wert) {
  const zs = sichtbareZeilen(wert); const ss = sichtbareSpalten(wert);
  if (!zs.length || !ss.length) return '';
  const zellen = wert.zellen || {};
  const inhalt = (z, s) => { const k = zellKey(z, s); return inlineMd(Object.hasOwn(zellen, k) ? zellen[k] : [], { zelle: true }).trim(); };
  const reihe = (z) => `| ${ss.map((s) => inhalt(z, s)).join(' | ')} |`;
  return [reihe(zs[0]), `| ${ss.map(() => '---').join(' | ')} |`, ...zs.slice(1).map(reihe)].join('\n');
}

/** Listennummern als Zahl je Ebene (wie listenNummern; ein Absatz ohne Liste beginnt neu). */
function listenZahlen(zeilen) {
  const zaehler = new Array(9).fill(0);
  return zeilen.map((z) => {
    const a = z.attribute || {};
    if (!a.liste) { zaehler.fill(0); return null; }
    const ebene = Math.min(8, Math.max(0, a.einzug || 0));
    if (a.liste !== 'zahlen') { for (let i = ebene; i < 9; i++) zaehler[i] = 0; return null; }
    zaehler[ebene] += 1;
    for (let i = ebene + 1; i < 9; i++) zaehler[i] = 0;
    return zaehler[ebene];
  });
}

/** Dokument → Markdown (genau ein \n am Ende). */
export function markdownSchreiben(daten) {
  const zeilen = zeilenAus(daten.delta || []);
  const zahlen = listenZahlen(zeilen);
  const teile = []; // {liste, text}
  zeilen.forEach((z, i) => {
    const a = z.attribute || {};
    if (z.block === 'seitenumbruch') { teile.push({ liste: false, text: '---' }); return; }
    if (z.block === 'tabelle') { const t = tabelleMd(z.inhalt[0].insert.tabelle); if (t) teile.push({ liste: false, text: t }); return; }
    let inhalt = inlineMd(z.inhalt).replace(/^[ \t]+|[ \t]+$/g, '');
    if (!inhalt) return;
    inhalt = zeilenanfang(inhalt);
    const zitat = a.zitat ? '> ' : '';
    if (a.liste) {
      const einzug = '    '.repeat(Math.min(8, Math.max(0, a.einzug || 0)));
      const marke = a.liste === 'zahlen' ? `${zahlen[i]}. ` : a.liste === 'aufgabe' ? `- [${a.erledigt ? 'x' : ' '}] ` : '- ';
      teile.push({ liste: true, text: zitat + einzug + marke + inhalt });
      return;
    }
    teile.push({ liste: false, text: zitat + (a.ueberschrift ? `${'#'.repeat(a.ueberschrift)} ` : '') + inhalt });
  });
  let aus = '';
  teile.forEach((x, i) => { if (i > 0) aus += x.liste && teile[i - 1].liste ? '\n' : '\n\n'; aus += x.text; });
  return `${aus}\n`;
}
