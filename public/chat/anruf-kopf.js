// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anrufen im Raumkopf (Plan 03): Knöpfe Anrufen (Audio) und Videoanruf, dazu ein Banner „Anruf läuft · n im Anruf –
// Beitreten“, solange in dem Raum jemand telefoniert und man selbst nicht dabei ist. Meldet sich ab, sobald das
// Element nicht mehr im Dokument hängt. Ohne app.js (auch für die Gastseite).

export function anrufKopf(raum, { h, steuerung, stand }) {
  const { el, t, symbol } = h;
  const beitreten = (video) => steuerung.beitreten(raum.id, { video, raumName: raum.name || '' });
  const knopf = (video) => el('button', {
    class: 'knopf-symbol', type: 'button', 'data-knopf': video ? 'video' : 'audio',
    'aria-label': t(video ? 'chat.anruf_video' : 'chat.anruf_audio'), title: t(video ? 'chat.anruf_video' : 'chat.anruf_audio'), onclick: () => beitreten(video),
  }, [symbol(video ? 'kamera' : 'anruf')]);
  const bannerText = el('span', { class: 'anruf-banner-text' });
  const banner = el('span', { class: 'anruf-banner', hidden: true, role: 'status' }, [
    symbol('anruf'), bannerText,
    el('button', { class: 'knopf knopf-klein', type: 'button', 'data-knopf': 'beitreten', onclick: () => beitreten(false) }, t('chat.anruf_beitreten')),
  ]);
  const knoten = el('span', { class: 'anruf-kopf' }, [banner, knopf(false), knopf(true)]);
  let warImDokument = false;
  const abmelden = [];
  const zeigen = () => {
    if (knoten.isConnected) warImDokument = true;
    else if (warImDokument) { for (const ab of abmelden.splice(0)) ab(); return; }
    const l = stand.laufende().get(raum.id);
    const ich = steuerung.aktiv();
    banner.hidden = !l || !!(ich && ich.raum === raum.id);
    bannerText.textContent = l ? t('chat.anruf_laeuft', { n: l.teilnehmer.length }) : '';
  };
  abmelden.push(stand.on(zeigen), steuerung.on(zeigen));
  zeigen();
  return knoten;
}
