// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eingabeleiste des Chats (Plan 02): Text (Enter sendet, Umschalt+Enter neue Zeile), Antwort auf eine Nachricht,
// Emojis, Dateien per Knopf, Ziehen oder Einfügen; Zeichenzähler ab 9000 Zeichen. Scheitert das Senden, bleibt alles
// stehen.

export const EMOJIS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🎉', '👀', '✅']);
const ZAEHLER_AB = 9000;
const TIPPEN_MS = 3000;

/** Was eine Taste im Eingabefeld bewirkt: 'senden' | 'zeile' | null (IME-Eingabe zählt nicht). */
export function tasteAuswerten({ key, shiftKey, ctrlKey, metaKey, isComposing }, { beruehrung = false } = {}) {
  if (key !== 'Enter' || isComposing) return null;
  if (ctrlKey || metaKey) return 'senden';
  // Am Handy (Touch) gibt es kein Umschalt+Enter: Enter macht eine neue Zeile, gesendet wird mit dem Knopf
  if (beruehrung) return 'zeile';
  return shiftKey ? 'zeile' : 'senden';
}

const kurz = (text, max = 80) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/**
 * Baut die Leiste in `behaelter`. `beiSenden({text, antwort, dateien})` darf ein Promise liefern: erst wenn es gelingt,
 * wird die Eingabe geleert. `beiTippen()` höchstens alle 3 s.
 */
export function eingabeLeiste(behaelter, { h, maxZeichen = 10000, beiSenden, beiTippen }) {
  const { el, t, symbol, format } = h;
  let antwort = null; let dateien = []; let letztesTippen = 0; let sendetGerade = false;

  const antwortText = el('span', { class: 'chat-eingabe-antwort-text' });
  const antwortZeile = el('div', { class: 'chat-eingabe-antwort', hidden: true }, [
    symbol('antworten'), antwortText,
    el('button', { class: 'knopf-symbol', type: 'button', 'aria-label': t('chat.antwort_weg'), onclick: () => leiste.antwortSetzen(null) }, [symbol('schliessen')]),
  ]);
  const dateiListe = el('ul', { class: 'chat-eingabe-dateien', hidden: true });
  const dateiWahl = el('input', { type: 'file', multiple: true, hidden: true, onchange: () => { leiste.dateienHinzu(dateiWahl.files); dateiWahl.value = ''; } });
  const feld = el('textarea', { class: 'chat-eingabe-feld', rows: '1', maxlength: String(maxZeichen), placeholder: t('chat.platzhalter'), 'aria-label': t('chat.platzhalter') });
  const zaehler = el('span', { class: 'chat-zeichen schwach klein', hidden: true, 'aria-live': 'polite' });
  const emojiKnopf = el('button', { class: 'knopf-symbol', type: 'button', 'aria-label': t('chat.emoji'), 'aria-expanded': 'false', onclick: () => emojiUmschalten() }, [symbol('smiley')]);
  const emojiWahl = el('div', { class: 'chat-emoji-wahl', hidden: true, role: 'group', 'aria-label': t('chat.emoji') },
    EMOJIS.map((e) => el('button', { class: 'chat-emoji', type: 'button', onclick: () => { einfuegen(e); emojiUmschalten(false); feld.focus(); } }, e)));

  const emojiUmschalten = (offen = emojiWahl.hidden) => { emojiWahl.hidden = !offen; emojiKnopf.setAttribute('aria-expanded', offen ? 'true' : 'false'); };

  function einfuegen(text) {
    const wert = feld.value || '';
    const a = Number.isInteger(feld.selectionStart) ? feld.selectionStart : wert.length;
    const b = Number.isInteger(feld.selectionEnd) ? feld.selectionEnd : a;
    feld.value = wert.slice(0, a) + text + wert.slice(b);
    try { feld.selectionStart = feld.selectionEnd = a + text.length; } catch { /* egal */ }
    nachEingabe(false);
  }

  function nachEingabe(tippen = true) {
    const n = (feld.value || '').length;
    zaehler.hidden = n < ZAEHLER_AB;
    if (!zaehler.hidden) zaehler.textContent = t('chat.zeichen', { n });
    if (feld.style && feld.scrollHeight) { feld.style.height = 'auto'; feld.style.height = `${Math.min(feld.scrollHeight, 200)}px`; }
    if (tippen && n && beiTippen && Date.now() - letztesTippen > TIPPEN_MS) { letztesTippen = Date.now(); beiTippen(); }
  }

  function dateienZeigen() {
    dateiListe.textContent = '';
    dateiListe.hidden = !dateien.length;
    dateien.forEach((d, i) => {
      dateiListe.appendChild(el('li', { class: 'chat-eingabe-datei' }, [
        symbol('anhang'), el('span', { class: 'chat-anhang-name', text: d.name }),
        el('span', { class: 'schwach klein', text: format && format.groesse ? format.groesse(d.size) : '' }),
        el('button', { class: 'knopf-symbol', type: 'button', 'aria-label': t('chat.datei_weg', { name: d.name }), onclick: () => { dateien.splice(i, 1); dateienZeigen(); } }, [symbol('schliessen')]),
      ]));
    });
  }

  function senden() {
    if (sendetGerade) return;
    const text = feld.value || '';
    if (!text.trim() && !dateien.length) return;
    sendetGerade = true;
    let r;
    try { r = beiSenden({ text, antwort: antwort ? antwort.id : null, dateien: [...dateien] }); } catch (e) { sendetGerade = false; console.error(e); return; }
    Promise.resolve(r).then(() => {
      if ((feld.value || '') === text) leiste.leeren();
      else { dateien = []; dateienZeigen(); leiste.antwortSetzen(null); } // inzwischen weitergetippt: das bleibt stehen
    }, () => { /* Fehler zeigt der Aufrufer; Eingabe bleibt */ }).finally(() => { sendetGerade = false; });
  }

  const beruehrung = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
  feld.addEventListener('keydown', (ev) => {
    if (tasteAuswerten(ev, { beruehrung }) !== 'senden') return;
    ev.preventDefault();
    senden();
  });
  feld.addEventListener('input', () => nachEingabe());
  feld.addEventListener('paste', (ev) => {
    const f = ev.clipboardData && ev.clipboardData.files;
    if (f && f.length) { ev.preventDefault(); leiste.dateienHinzu(f); }
  });

  const knoten = el('div', { class: 'chat-eingabe' }, [
    antwortZeile, dateiListe, emojiWahl,
    el('div', { class: 'chat-eingabe-zeile' }, [
      el('button', { class: 'knopf-symbol', type: 'button', 'aria-label': t('chat.anhang_hinzu'), onclick: () => dateiWahl.click() }, [symbol('anhang')]),
      emojiKnopf, feld,
      el('button', { class: 'knopf chat-senden', type: 'button', 'aria-label': t('chat.senden'), title: t('chat.senden'), onclick: () => senden() }, [symbol('senden')]),
    ]),
    zaehler, dateiWahl,
  ]);
  const hatDateien = (ev) => !!(ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files'));
  knoten.addEventListener('dragover', (ev) => { if (hatDateien(ev)) { ev.preventDefault(); knoten.classList.add('ziehen'); } });
  knoten.addEventListener('dragleave', () => knoten.classList.remove('ziehen'));
  knoten.addEventListener('drop', (ev) => {
    knoten.classList.remove('ziehen');
    if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    leiste.dateienHinzu(ev.dataTransfer.files);
  });
  behaelter.appendChild(knoten);

  const leiste = {
    antwortSetzen(n) {
      antwort = n || null;
      antwortZeile.hidden = !antwort;
      antwortText.textContent = antwort ? `${antwort.von_name || ''}: ${kurz(antwort.text)}` : '';
      if (antwort) feld.focus();
    },
    leeren() {
      feld.value = ''; dateien = []; dateienZeigen(); leiste.antwortSetzen(null); emojiUmschalten(false); nachEingabe(false);
    },
    fokus() { feld.focus(); },
    dateienHinzu(liste) {
      for (const d of Array.from(liste || [])) if (d) dateien.push(d);
      dateienZeigen();
    },
  };
  return leiste;
}
