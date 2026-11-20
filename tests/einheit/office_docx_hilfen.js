// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Gemeinsame Testdaten für docx (Plan 05 Aufgaben 16–18): ein Dokument D mit allen unterstützten Merkmalen (Überschriften,
// Inline-Formate, Paletten- und eigene Farben, Links, Listen in zwei Blöcken, Aufgaben, Einzug, Ausrichtung, Zitat, Tab,
// Sonderzeichen, Seitenumbruch, Bild, zwei Tabellen direkt hintereinander – eine mit Grabstein und Breite), ein Bild-Lader
// und ein PNG-Kopf mit 2×1 Pixeln.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const { normalisieren } = await import(pathToFileURL(path.join(HIER, '..', '..', 'public', 'gemeinsam', 'sync', 'delta.js')).href);

/** PNG-Kopf: 8 Signaturbytes, IHDR-Länge 13, „IHDR“, Breite 2, Höhe 1 (Rest beliebig). */
export const PNG_2x1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]);
export const BILD = 'abcdefghijkl-logo.png';
export const ZEIT = new Date('2026-10-18T12:34:56.789Z');
export const LINK = 'https://fah.de/a?a=1&b=2';

/** Bild-Lader wie der Editor: nur BILD ist vorhanden. */
export const lader = async (datei) => (datei === BILD ? { bytes: PNG_2x1, mime: 'image/png' } : null);

export const T1 = Object.freeze({
  id: 'tabelle1', zeilen: ['zeileA1', 'zeileB1', 'zeileC1'], spalten: ['spalteA1', 'spalteB1'], weg: ['zeileC1'],
  zellen: {
    'zeileA1|spalteA1': [{ insert: 'Kopf', attributes: { fett: true } }],
    'zeileA1|spalteB1': [{ insert: 'B1' }],
    'zeileB1|spalteA1': [{ insert: 'Zeile\nzwei' }],
    'zeileB1|spalteB1': [{ insert: 'Web', attributes: { link: 'https://fah.de/t' } }],
  },
  breiten: { spalteA1: 200 },
});
export const T2 = Object.freeze({
  id: 'tabelle2', zeilen: ['zeileA2', 'zeileB2'], spalten: ['spalteA2', 'spalteB2'], weg: [],
  zellen: { 'zeileA2|spalteA2': [{ insert: 'x' }], 'zeileB2|spalteB2': [{ insert: 'y' }] },
  breiten: {},
});

export const D = Object.freeze({
  delta: normalisieren([
    { insert: 'Titel' }, { insert: '\n', attributes: { ueberschrift: 1 } },
    { insert: 'Abschnitt' }, { insert: '\n', attributes: { ueberschrift: 2 } },
    { insert: 'Unterabschnitt' }, { insert: '\n', attributes: { ueberschrift: 3 } },
    { insert: 'Normal ' }, { insert: 'fett', attributes: { fett: true } }, { insert: ' ' }, { insert: 'kursiv', attributes: { kursiv: true } }, { insert: ' ' },
    { insert: 'unter', attributes: { unterstrichen: true } }, { insert: ' ' }, { insert: 'durch', attributes: { durchgestrichen: true } }, { insert: ' ' },
    { insert: 'code', attributes: { code: true } }, { insert: ' ' }, { insert: 'rot', attributes: { farbe: 'rot' } }, { insert: ' ' },
    { insert: 'eigen', attributes: { farbe: '#123456' } }, { insert: ' ' }, { insert: 'gelb', attributes: { hintergrund: 'gelb' } }, { insert: ' ' },
    { insert: 'hell', attributes: { hintergrund: '#abcdef' } }, { insert: ' ' },
    { insert: 'alles', attributes: { fett: true, kursiv: true, unterstrichen: true, durchgestrichen: true, farbe: 'blau', hintergrund: 'rosa' } }, { insert: '\n' },
    { insert: 'Li', attributes: { link: LINK } }, { insert: 'nk', attributes: { link: LINK, fett: true } }, { insert: ' und ' },
    { insert: 'Mail', attributes: { link: 'mailto:info@fah.de' } }, { insert: ' ' }, { insert: 'Code-Link', attributes: { link: LINK, code: true } }, { insert: ' ' },
    { insert: 'kommentiert', attributes: { kommentar: 'kommentar1' } }, { insert: '\n' },
    { insert: 'Punkt' }, { insert: '\n', attributes: { liste: 'punkte' } },
    { insert: 'Eins' }, { insert: '\n', attributes: { liste: 'zahlen' } },
    { insert: 'Unterpunkt' }, { insert: '\n', attributes: { liste: 'zahlen', einzug: 1 } },
    { insert: 'Erledigt' }, { insert: '\n', attributes: { liste: 'aufgabe', erledigt: true } },
    { insert: 'Offen' }, { insert: '\n', attributes: { liste: 'aufgabe' } },
    { insert: 'Eingerückt' }, { insert: '\n', attributes: { einzug: 2 } },
    { insert: 'Blocksatz' }, { insert: '\n', attributes: { ausrichtung: 'block' } },
    { insert: 'Mitte' }, { insert: '\n', attributes: { ausrichtung: 'mitte' } },
    { insert: 'Rechts' }, { insert: '\n', attributes: { ausrichtung: 'rechts' } },
    { insert: 'Zitat' }, { insert: '\n', attributes: { zitat: true } },
    { insert: 'Tab\tund <&> 😀\n' },
    { insert: { seitenumbruch: true } }, { insert: '\n' },
    { insert: 'Bild: ' }, { insert: { bild: { datei: BILD, breite: 300, alt: 'Logo' } } }, { insert: '\n' },
    { insert: { tabelle: T1 } }, { insert: '\n' }, { insert: { tabelle: T2 } }, { insert: '\n' },
    { insert: 'Zahl' }, { insert: '\n', attributes: { liste: 'zahlen' } },
    { insert: 'Ende\n' },
  ]),
  kommentare: { kommentar1: { wer: 'anna', name: 'Anna', zeit: '2026-10-18T10:00:00Z', text: 'Bitte prüfen', erledigt: false, antworten: [] } },
});
