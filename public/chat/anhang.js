// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Anhänge im Browser (Plan 02): Adressen, Darstellung (Bild als Vorschau, Video mit Steuerung, sonst Dateizeile)
// und die Wahl je Empfänger, was mit der Datei geschieht: herunterladen, im Standardordner auf dem NAS speichern oder
// einen anderen Ordner wählen (Gäste: nur herunterladen). Hochladen per XHR mit Fortschritt.

import { ChatFehler } from './verbindung.js';

/** Adresse eines Anhangs; `vorschau` (128/256/512) liefert ein kleines Bild, `herunterladen` erzwingt den Download. */
export function anhangUrl(raum, anhang, { vorschau, herunterladen } = {}) {
  let u = `/api/chat/anhang?raum=${encodeURIComponent(raum)}&anhang=${encodeURIComponent(anhang)}`;
  if (vorschau) u += `&vorschau=${encodeURIComponent(vorschau)}`;
  if (herunterladen) u += '&herunterladen=1';
  return u;
}

const ordnerText = (o) => (o.pfad ? `${o.freigabe}/${o.pfad}` : o.freigabe);

/** Einträge der Auswahl unter einem Anhang: herunterladen, Standardordner (wenn gesetzt), anderen Ordner wählen. */
export function menueEintraege(anhang, { h, standardordner = null, istGast = false } = {}) {
  const aus = [{ id: 'herunterladen', text: h.t('chat.anhang_herunterladen') }];
  if (istGast) return aus;
  if (standardordner && standardordner.freigabe) aus.push({ id: 'standard', text: h.t('chat.anhang_in', { ordner: ordnerText(standardordner) }) });
  aus.push({ id: 'waehlen', text: h.t('chat.anhang_waehlen') });
  return aus;
}

/**
 * Element eines Anhangs. `url(optionen)` liefert seine Adresse (siehe anhangUrl), `beiSpeichern(anhang, ziel)` speichert
 * auf dem NAS – `ziel` = Standardordner oder null (dann fragt der Aufrufer nach dem Ordner).
 */
export function anhangElement(anhang, { h, url, standardordner = null, istGast = false, beiSpeichern }) {
  const { el, t, symbol, format } = h;
  const mime = String(anhang.mime || '');
  let inhalt;
  if (anhang.bild || mime.startsWith('image/')) {
    inhalt = el('a', { class: 'chat-anhang-bild', href: url(), target: '_blank', rel: 'noopener' }, [
      el('img', { src: url({ vorschau: 256 }), loading: 'lazy', decoding: 'async', alt: anhang.name || '' }),
    ]);
  } else if (anhang.video || mime.startsWith('video/')) {
    inhalt = el('video', { class: 'chat-anhang-video', src: url(), controls: true, preload: 'metadata' });
  } else {
    inhalt = el('div', { class: 'chat-anhang-datei' }, [
      symbol('anhang'), el('span', { class: 'chat-anhang-name', text: anhang.name || '' }),
      el('span', { class: 'chat-anhang-groesse schwach', text: format && format.groesse ? format.groesse(anhang.groesse) : '' }),
    ]);
  }
  const eintraege = menueEintraege(anhang, { h, standardordner, istGast });
  const wahl = el('select', { class: 'chat-anhang-wahl', 'aria-label': t('chat.anhang_was', { name: anhang.name || '' }) },
    eintraege.map((e) => el('option', { value: e.id, text: e.text })));
  const ausfuehren = () => {
    const was = wahl.value || eintraege[0].id;
    if (was === 'standard') { if (beiSpeichern) beiSpeichern(anhang, standardordner); return; }
    if (was === 'waehlen') { if (beiSpeichern) beiSpeichern(anhang, null); return; }
    const link = el('a', { href: url({ herunterladen: true }), download: anhang.name || '' });
    document.body.appendChild(link); link.click(); link.remove();
  };
  return el('div', { class: 'chat-anhang' }, [
    inhalt,
    el('div', { class: 'chat-anhang-aktion' }, [
      wahl,
      el('button', { class: 'knopf knopf-zweit knopf-klein chat-anhang-los', type: 'button', onclick: ausfuehren }, t('chat.anhang_los')),
    ]),
  ]);
}

/** Lädt eine Datei als Anhang in einen Raum hoch: {fertig: Promise<anhang>, abbrechen()}. */
export function anhangHochladen(raum, datei, { beiFortschritt } = {}) {
  const xhr = new XMLHttpRequest();
  const fertig = new Promise((ok, nein) => {
    xhr.open('POST', `/api/chat/hochladen?raum=${encodeURIComponent(raum)}&name=${encodeURIComponent(datei.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (xhr.upload && beiFortschritt) xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && ev.total) beiFortschritt(ev.loaded / ev.total); };
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch { /* keine JSON-Antwort */ }
      if (xhr.status === 200 && j && j.ok && j.ergebnis && j.ergebnis.anhang) { ok(j.ergebnis.anhang); return; }
      const f = (j && j.fehler) || {};
      nein(new ChatFehler(f.code || 'E_AGENT', f.meldung || `HTTP ${xhr.status}`, f.details));
    };
    xhr.onerror = () => nein(new ChatFehler('E_AGENT', 'Netzwerkfehler beim Hochladen'));
    xhr.onabort = () => nein(new ChatFehler('E_ABGEBROCHEN', 'Hochladen abgebrochen'));
    xhr.send(datei);
  });
  return { fertig, abbrechen() { try { xhr.abort(); } catch { /* schon fertig */ } } };
}
