// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Avatare (0.22.0, Betreiber 19.10.2026: „avatar/bild … was dann als userbild überall angezeigt wird“): ein Baustein für
// alle Oberflächen – das Bild des Nutzers oder, ohne Bild, sein Anfangsbuchstabe im Kreis (feste Farbe je Person). Die
// Versionen kommen einmal aus nutzer.avatare (avatareSetzen); ändert sich eins, tauschen alle sichtbaren Avatare sofort
// (data-avatar). Ohne Login-Namen (Chat-Gäste, Gastseite) gibt es nie ein Bild. Ohne app.js (läuft auch auf der Gastseite).

const versionen = new Map(); // Login-Name → Version (12 Hex)
/** Kantenlänge des hochgeladenen Bildes (px). */
export const AVATAR_PX = 256;

/** Versionen {name: v} übernehmen (aus nutzer.avatare) und alle sichtbaren Avatare neu zeichnen. */
export function avatareSetzen(objekt) {
  versionen.clear();
  for (const [name, v] of Object.entries(objekt && typeof objekt === 'object' ? objekt : {})) if (typeof v === 'string' && v) versionen.set(name, v);
  if (typeof document !== 'undefined') for (const k of document.querySelectorAll('[data-avatar]')) zeichnen(k);
}

/** Adresse des Bildes oder null (kein Bild hinterlegt). */
export function avatarUrl(name) {
  const v = name ? versionen.get(name) : null;
  return v ? `/api/avatar/${encodeURIComponent(name)}?v=${v}` : null;
}

/** Erstes Zeichen (auch Umlaut oder Emoji) groß; leer → „?“. */
export function anfangsbuchstabe(text) {
  const z = Array.from(String(text ?? '').trim())[0];
  return z ? z.toUpperCase() : '?';
}

/** Feste Farbe je Person (aus dem Namen), damit Buchstaben-Kreise unterscheidbar bleiben. */
function farbeVon(text) {
  let h = 0;
  for (const z of String(text || '?')) h = (h * 31 + z.codePointAt(0)) % 360;
  return `hsl(${h} 45% 40%)`;
}

/**
 * Avatar-Knoten <span class="avatar">: name = Login (nur dann ein Bild), anzeige = Text für den Buchstaben, groesse in
 * px, farbe = feste Farbe (z. B. die Sitzungsfarbe im Office), titel = Name für Screenreader (sonst nur Schmuck).
 */
export function avatarKnoten({ name = '', anzeige = '', groesse = 32, farbe = '', klasse = '', titel = '' } = {}) {
  const k = document.createElement('span');
  k.className = klasse ? `avatar ${klasse}` : 'avatar';
  k.style.setProperty('--avatar-groesse', `${groesse}px`);
  if (titel) { k.setAttribute('role', 'img'); k.setAttribute('aria-label', titel); k.title = titel; } else k.setAttribute('aria-hidden', 'true');
  avatarAendern(k, { name, anzeige, farbe });
  return k;
}

/** Vorhandenen Knoten auf eine (andere) Person setzen – z. B. eine wiederverwendete Kachel. */
export function avatarAendern(k, { name = '', anzeige = '', farbe = '' } = {}) {
  if (name) k.setAttribute('data-avatar', name); else k.removeAttribute('data-avatar');
  k.setAttribute('data-anzeige', anzeige || name || '');
  k.style.setProperty('--avatar-farbe', farbe || farbeVon(name || anzeige));
  zeichnen(k);
}

function buchstabe(k) {
  k.textContent = anfangsbuchstabe(k.getAttribute('data-anzeige'));
  k.classList.remove('avatar-bild');
}

/** Bild oder Buchstabe nach dem aktuellen Stand; ein Bild, das nicht lädt (gelöscht, kein Recht), wird zum Buchstaben. */
function zeichnen(k) {
  const url = avatarUrl(k.getAttribute('data-avatar'));
  if (!url) { buchstabe(k); return; }
  const da = k.querySelector('img');
  if (da && da.getAttribute('src') === url) return;
  const img = document.createElement('img');
  img.setAttribute('alt', '');
  img.setAttribute('decoding', 'async');
  img.setAttribute('draggable', 'false');
  img.addEventListener('error', () => { if (img.parentNode === k) buchstabe(k); });
  img.setAttribute('src', url);
  k.textContent = '';
  k.appendChild(img);
  k.classList.add('avatar-bild');
}

/** Quadratischer Ausschnitt aus der Bildmitte (wie object-fit: cover): Quelle {sx, sy, s}. */
export function zuschnitt(breite, hoehe) {
  const s = Math.min(breite, hoehe);
  return { sx: Math.round((breite - s) / 2), sy: Math.round((hoehe - s) / 2), s };
}

/**
 * Gewählte Bilddatei → quadratisches Bild mit AVATAR_PX Kantenlänge (WebP; kann der Browser kein WebP, PNG) als base64 –
 * so bleibt jedes Foto klein, egal wie groß die Datei war. Liest der Browser die Datei nicht (z. B. HEIC), wirft es.
 */
export async function bildVorbereiten(datei, { px = AVATAR_PX } = {}) {
  const bild = await createImageBitmap(datei);
  try {
    const { sx, sy, s } = zuschnitt(bild.width, bild.height);
    const leinwand = document.createElement('canvas');
    leinwand.width = px; leinwand.height = px;
    const g = leinwand.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bild, sx, sy, s, s, 0, 0, px, px);
    const blob = await new Promise((ok) => leinwand.toBlob(ok, 'image/webp', 0.9));
    if (!blob) throw new Error('Bild konnte nicht umgewandelt werden');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let roh = '';
    for (let i = 0; i < bytes.length; i += 0x8000) roh += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(roh);
  } finally { if (typeof bild.close === 'function') bild.close(); }
}
