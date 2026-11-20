// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht eines laufenden Anrufs (Plan 03): Raster mit einer Kachel je Person (Video oder Avatar/Anfangsbuchstabe, Name,
// Mikrofon-aus-Zeichen), eigene Kachel stumm und gespiegelt, Steuerleiste (Mikrofon, Kamera, Bildschirm, Geräte,
// Vollbild, Auflegen). Kacheln bleiben beim Aktualisieren erhalten (laufende Videos brechen nicht ab). Ohne app.js.

import { Anruf } from './anruf.js';
import { avatarKnoten, avatarAendern } from '../avatar.js';

/** Raster nach Personenzahl: 1, 2, 3–4, 5–6. */
export function rasterKlasse(anzahl) {
  if (anzahl <= 1) return 'anruf-raster-1';
  if (anzahl === 2) return 'anruf-raster-2';
  return anzahl <= 4 ? 'anruf-raster-4' : 'anruf-raster-6';
}

/** Knöpfe der Leiste nach Zustand (Text = Sprachschlüssel der Handlung, die der Knopf auslöst). */
export function steuerKnoepfe({ audio, video, bildschirm, kannBildschirm }) {
  const k = [
    { id: 'mikrofon', symbol: audio ? 'mikrofon' : 'mikrofon_aus', text: audio ? 'chat.anruf_mikro_aus' : 'chat.anruf_mikro_an' },
    { id: 'kamera', symbol: video ? 'kamera' : 'kamera_aus', text: video ? 'chat.anruf_kamera_aus' : 'chat.anruf_kamera_an' },
  ];
  if (kannBildschirm) k.push({ id: 'bildschirm', symbol: 'bildschirm', text: bildschirm ? 'chat.anruf_bildschirm_ende' : 'chat.anruf_bildschirm' });
  k.push(
    { id: 'geraete', symbol: 'menue', text: 'chat.anruf_geraete' },
    { id: 'vollbild', symbol: 'vollbild', text: 'chat.anruf_vollbild' },
    { id: 'auflegen', symbol: 'auflegen', text: 'chat.anruf_auflegen' },
  );
  return k;
}

function kannBildschirmTeilen() {
  const md = globalThis.navigator && globalThis.navigator.mediaDevices;
  const grob = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
  return !!md && typeof md.getDisplayMedia === 'function' && !grob;
}

/** Baut die Ansicht in `behaelter`: {aktualisieren(), meldung(text), verlassen()}. */
export function anrufAnsicht(behaelter, { h, anruf, raumName, beiAuflegen, beiKlein }) {
  const { el, t, symbol } = h;
  const raster = el('div', { class: 'anruf-raster' });
  const meldungZeile = el('p', { class: 'anruf-meldung', role: 'status', hidden: true });
  const leiste = el('div', { class: 'anruf-leiste', role: 'toolbar', 'aria-label': t('chat.anruf_audio') });
  const kopf = el('div', { class: 'anruf-ebene-kopf' }, [
    el('span', { class: 'anruf-titel', text: raumName || '' }),
    el('button', { class: 'knopf-symbol anruf-klein-knopf', type: 'button', 'aria-label': t('chat.anruf_verkleinern'), title: t('chat.anruf_verkleinern'), onclick: () => { if (beiKlein) beiKlein(); } }, [symbol('zurueck')]),
  ]);
  behaelter.appendChild(kopf); behaelter.appendChild(raster); behaelter.appendChild(meldungZeile); behaelter.appendChild(leiste);
  const kacheln = new Map();

  function kachelBauen(x) {
    const video = el('video', { autoplay: true, playsinline: true });
    if (x.eigen) { video.muted = true; video.setAttribute('muted', ''); }
    const initial = avatarKnoten({ name: x.nutzer || '', anzeige: x.name || '', groesse: 72, klasse: 'anruf-initial' }); // Bild nur für Mitglieder (0.22.0)
    const name = el('span', { class: 'anruf-name' });
    const unterschrift = el('div', { class: 'anruf-unterschrift' }, [name]);
    const knoten = el('div', { class: `anruf-kachel${x.eigen ? ' anruf-eigen' : ''}`, 'data-teilnehmer': x.eigen ? 'ich' : x.id }, [video, initial, unterschrift]);
    return { knoten, video, initial, name, unterschrift, mikro: null };
  }

  function kachelSetzen(k, x) {
    if (k.video.srcObject !== (x.strom || null)) k.video.srcObject = x.strom || null;
    const m = x.medien || {};
    const bild = !!(m.video || m.bildschirm);
    k.video.classList.toggle('anruf-ohne-bild', !bild);
    k.initial.hidden = bild;
    avatarAendern(k.initial, { name: x.nutzer || '', anzeige: x.name || '' });
    k.name.textContent = x.eigen ? (x.name ? `${x.name} ${t('chat.du')}` : t('chat.du')) : `${x.name || ''}${x.gast ? ` (${t('chat.gast')})` : ''}`;
    if (m.audio === false && !k.mikro) { k.mikro = symbol('mikrofon_aus', 'anruf-mikro-aus'); k.unterschrift.insertBefore(k.mikro, k.name); }
    if (m.audio !== false && k.mikro) { k.mikro.remove(); k.mikro = null; }
    k.knoten.classList.toggle('anruf-getrennt', x.verbindung === 'failed' || x.verbindung === 'disconnected');
  }

  async function geraeteDialog() {
    let g;
    try { g = await Anruf.geraete(); } catch { g = { mikrofone: [], kameras: [] }; }
    const auswahl = (liste) => el('select', { class: 'eingabe' }, liste.map((d) => el('option', { value: d.id, text: d.name })));
    const mik = auswahl(g.mikrofone); const kam = auswahl(g.kameras);
    const d = el('dialog', { class: 'anruf-geraete' }, [
      el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('chat.anruf_mikrofon') }), mik]),
      g.kameras.length ? el('label', { class: 'feld' }, [el('span', { class: 'feld-beschriftung', text: t('chat.anruf_kamera') }), kam]) : null,
      el('div', { class: 'dialog-knoepfe' }, [
        el('button', { class: 'knopf knopf-zweit', type: 'button', onclick: () => { d.close(); d.remove(); } }, t('chat.abbrechen')),
        el('button', { class: 'knopf', type: 'button', onclick: async () => {
          d.close(); d.remove();
          try { await anruf.geraetWechseln({ mikrofonId: mik.value || undefined, kameraId: g.kameras.length ? kam.value || undefined : undefined }); } catch { /* bleibt beim alten Gerät */ }
        } }, t('chat.uebernehmen')),
      ]),
    ]);
    behaelter.appendChild(d);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  const handlungen = {
    mikrofon: () => anruf.mikrofon(!anruf.medienStand.audio),
    kamera: () => anruf.kamera(!anruf.medienStand.video),
    bildschirm: () => anruf.bildschirm(!anruf.medienStand.bildschirm),
    geraete: () => geraeteDialog(),
    vollbild: () => { try { (behaelter.requestFullscreen || behaelter.webkitRequestFullscreen)?.call(behaelter); } catch { /* ohne Vollbild */ } },
    auflegen: () => { if (beiAuflegen) beiAuflegen(); },
  };

  function leisteBauen() {
    leiste.textContent = '';
    for (const k of steuerKnoepfe({ ...anruf.medienStand, kannBildschirm: kannBildschirmTeilen() })) {
      leiste.appendChild(el('button', {
        class: `knopf knopf-symbol anruf-knopf${k.id === 'auflegen' ? ' anruf-auflegen' : ''}`, type: 'button', 'data-knopf': k.id, 'aria-label': t(k.text), title: t(k.text),
        onclick: () => { Promise.resolve(handlungen[k.id]()).catch(() => {}).finally(() => aktualisieren()); },
      }, [symbol(k.symbol)]));
    }
  }

  function aktualisieren() {
    const liste = [{ id: '__ich', eigen: true, name: anruf.eigenerName || '', nutzer: anruf.eigenerNutzer || '', medien: anruf.medienStand, strom: anruf.lokalerStrom }, ...anruf.teilnehmer.values()];
    raster.className = `anruf-raster ${rasterKlasse(liste.length)}`;
    const ids = new Set(liste.map((x) => x.id));
    for (const [id, k] of kacheln) if (!ids.has(id)) { k.video.srcObject = null; k.knoten.remove(); kacheln.delete(id); }
    liste.forEach((x, i) => {
      let k = kacheln.get(x.id);
      if (!k) { k = kachelBauen(x); kacheln.set(x.id, k); }
      kachelSetzen(k, x);
      if (raster.childNodes[i] !== k.knoten) raster.insertBefore(k.knoten, raster.childNodes[i] || null);
    });
    leisteBauen();
  }

  const ab = ['teilnehmer', 'strom', 'lokal', 'zustand'].map((art) => anruf.on(art, () => aktualisieren()));
  aktualisieren();

  return {
    aktualisieren,
    meldung(text) { meldungZeile.hidden = !text; meldungZeile.textContent = text || ''; },
    verlassen() {
      for (const x of ab) { try { x(); } catch { /* egal */ } }
      for (const k of kacheln.values()) k.video.srcObject = null;
    },
  };
}
