// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Suche in der Kopfzeile (Betreiber 12.10.2026: „Suche in der Kopfzeile (Strg+K) … landest direkt bei der Einstellung,
// Freigabe, App oder dem Nutzer“). Feste Einträge (Seiten, Einstellungskarten mit Stichwörtern) plus Freigaben, Apps,
// Nutzer, VMs und Spiegelungen aus dem Agenten. Ein Treffer setzt den Sprung-Hash (#/<ansicht>/<karte> bzw.
// #/<ansicht>/ziel/<name>); die Ansicht scrollt hin und hebt hervor.

import { el, t, symbol, hashFuer, dialog } from './app.js';
import { api } from './api.js';

/** Einstellungskarten der System-Seite: Titel-Schlüssel + Stichwörter (auch Begriffe, die nicht im Titel stehen). */
const SYSTEM_KARTEN = Object.freeze([
  ['allgemein', 'system.allgemein_titel', 'hostname name zeitzone sprache uhrzeit'],
  ['netzwerk', 'system.netz_titel', 'ip adresse dns gateway dhcp lan'],
  ['standort', 'system.standort_titel', 'weltkarte verbindungen ort'],
  ['dienste', 'system.dienste_titel', 'samba smb docker ssh avahi libvirt'],
  ['docker', 'system.docker_freigabe_titel', 'docker ordner freigabe'],
  ['fahgit', 'system.fahgit_titel', 'fah-git git gitea gitlab token zugangsschlüssel projekt bauen docker'],
  ['vpn', 'system.vpn_titel', 'wireguard fernzugriff unterwegs tunnel'],
  ['protokolle', 'system.proto_titel', 'sftp webdav nfs dlna medienserver'],
  ['benachrichtigungen', 'system.benachrichtigung_titel', 'email e-mail mail ntfy push meldung alarm'],
  ['grafikkarte', 'system.gpu_titel', 'gpu nvidia intel amd transkodierung'],
  ['gehaeuse', 'system.gehaeuse_titel', 'led leds lüfter luefter fan gehäuse ugreen temperatur'],
  ['platten', 'system.energie_titel', 'festplatten standby ruhe schlafen spindown'],
  ['energie', 'system.energie2_titel', 'usv wake-on-lan wol zeitplan ausschalten einschalten strom'],
  ['smart', 'system.smart_titel', 'smart gesundheit festplatte fehler temperatur'],
  ['pruefungen', 'system.pruefungen_titel', 'selbsttest smart prüfung raid datenprüfung scrub automatisch'],
  ['strom', 'system.strom_titel', 'neustart herunterfahren reboot ausschalten'],
  ['programm', 'system.programm_titel', 'update aktualisieren version fah-nas'],
  ['updates', 'system.updates_titel', 'ubuntu pakete sicherheitsupdates apt'],
  ['autoupdates', 'system.auto_titel', 'unattended automatisch sicherheitsupdates neustart nachts'],
  ['export', 'system.export_titel', 'konfiguration sichern backup import zurückspielen'],
  ['protokoll', 'system.protokoll_titel', 'log ereignisse audit wer hat'],
  ['ueber', 'system.ueber_titel', 'version kernel laufzeit info'],
]);

/** Zusätzliche Stichwörter für ganze Seiten. */
const SEITEN_STICHWORTE = Object.freeze({
  dashboard: 'start übersicht kacheln', dateien: 'datei ordner hochladen dateimanager', apps: 'docker container katalog app store übernehmen altes nas ugos compose',
  vms: 'virtuelle maschine vm windows linux iso', freigaben: 'smb ordner netzwerkordner rechte time machine',
  laufwerke: 'usb platte festplatte extern auswerfen raid verbund ugos synology übernehmen umstieg speicherort docker umziehen platte ersetzen spiegel', nutzer: 'konto passwort benutzer gruppe 2fa',
  snapshots: 'schnappschuss wiederherstellen version zeitplan', spiegelung: 'sicherung backup abgleich sync kopie cloud',
  system: 'einstellungen',
});

/** Text für den Vergleich: klein, ohne Akzente, ä/ö/ü/ß gleich ae/oe/ue/ss. */
export function normieren(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Treffer bewerten (höher = besser, 0 = kein Treffer). Jedes Suchwort muss vorkommen; Titelanfang > Wortanfang im Titel
 * > irgendwo im Titel > Stichwort/Zusatz.
 */
export function bewerten(eintrag, anfrage) {
  const woerter = normieren(anfrage).split(/\s+/).filter(Boolean);
  if (!woerter.length) return 0;
  const titel = normieren(eintrag.titel); const rest = normieren(`${eintrag.unter || ''} ${eintrag.stichworte || ''}`);
  let summe = 0;
  for (const w of woerter) {
    if (titel.startsWith(w)) summe += 100;
    else if (new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(titel)) summe += 60;
    else if (titel.includes(w)) summe += 40;
    else if (rest.includes(w)) summe += 15;
    else return 0;
  }
  return summe + (eintrag.vorrang || 0);
}

/** Beste Treffer (höchstens `max`), bei Gleichstand nach Art und Titel. */
export function suchen(eintraege, anfrage, max = 12) {
  return eintraege.map((e) => ({ e, p: bewerten(e, anfrage) })).filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p || a.e.titel.localeCompare(b.e.titel)).slice(0, max).map((x) => x.e);
}

/** Feste Einträge: sichtbare Seiten, RAID, App-Katalog, Darstellung, für Admins die Einstellungskarten. */
export function festeEintraege({ ansichten = [], admin = false, seitenText = (id) => id } = {}) {
  const aus = ansichten.map((a) => ({ art: 'seite', titel: seitenText(a.id), stichworte: SEITEN_STICHWORTE[a.id] || '', ziel: hashFuer(a.id), symbol: a.id, vorrang: 5 }));
  const hat = (id) => ansichten.some((a) => a.id === id);
  if (admin && hat('laufwerke')) aus.push({ art: 'einstellung', titel: t('laufwerke.raid_titel'), stichworte: 'raid verbund speicherverbund mdadm platten', ziel: hashFuer('laufwerke', 'raid'), symbol: 'laufwerke' });
  if (admin && hat('apps')) aus.push({ art: 'einstellung', titel: t('suche.app_katalog'), stichworte: 'katalog unraid installieren store', ziel: hashFuer('apps', 'katalog'), symbol: 'apps' });
  if (admin && hat('spiegelung')) aus.push({ art: 'einstellung', titel: t('suche.sicherung_einrichten'), stichworte: 'sicherung backup einrichten assistent usb cloud nas', ziel: hashFuer('spiegelung', 'neu'), symbol: 'spiegelung' });
  aus.push({ art: 'einstellung', titel: t('kopf.darstellung'), stichworte: 'theme design dunkel hell glas transparenz hintergrund tapete akzent farbe sprache englisch', aktion: 'darstellung', symbol: 'darstellung' });
  if (admin && hat('system')) {
    for (const [id, schluessel, worte] of SYSTEM_KARTEN) aus.push({ art: 'einstellung', titel: t(schluessel), unter: t('navigation.system'), stichworte: worte, ziel: hashFuer('system', id), symbol: 'system' });
  }
  return aus;
}

/** Einträge aus dem Agenten (je Liste ein Aufruf; Fehler/fehlende Rechte → leer). */
async function dynamischeEintraege(admin) {
  const listeAus = (r, feld) => (Array.isArray(r) ? r : (r && Array.isArray(r[feld]) ? r[feld] : []));
  const holen = async (aktion, params = {}) => { try { return await api(aktion, params); } catch { return null; } };
  const [fr, ap, nu, gr, vm, sp] = await Promise.all([
    holen('freigaben.liste'), holen('apps.liste'), admin ? holen('nutzer.liste') : null, admin ? holen('nutzer.gruppen') : null,
    admin ? holen('vms.liste') : null, admin ? holen('spiegelung.liste') : null,
  ]);
  const aus = [];
  for (const f of listeAus(fr, 'freigaben')) aus.push({ art: 'freigabe', titel: f.name, unter: f.beschreibung || '', ziel: hashFuer('freigaben', 'ziel', f.name), symbol: 'freigaben' });
  for (const a of listeAus(ap, 'apps')) aus.push({ art: 'app', titel: a.titel || a.name, unter: a.name !== (a.titel || a.name) ? a.name : '', stichworte: a.name, ziel: hashFuer('apps', 'ziel', a.name), symbol: 'apps' });
  for (const n of listeAus(nu, 'nutzer')) aus.push({ art: 'nutzer', titel: n.name, unter: n.anzeigename && n.anzeigename !== n.name ? n.anzeigename : '', stichworte: n.anzeigename || '', ziel: hashFuer('nutzer', 'ziel', n.name), symbol: 'nutzer' });
  for (const g of listeAus(gr, 'gruppen')) aus.push({ art: 'gruppe', titel: `@${g.name}`, stichworte: g.name, ziel: hashFuer('nutzer', 'ziel', `@${g.name}`), symbol: 'nutzer' });
  for (const v of listeAus(vm, 'vms')) aus.push({ art: 'vm', titel: v.titel || v.name, stichworte: v.name, ziel: hashFuer('vms', 'ziel', v.name), symbol: 'vms' });
  for (const s of listeAus(sp, 'spiegelungen')) aus.push({ art: 'spiegelung', titel: s.name || s.id, ziel: hashFuer('spiegelung', 'ziel', String(s.id)), symbol: 'spiegelung' });
  return aus;
}

let zwischenspeicher = { zeit: 0, admin: null, nutzer: null, eintraege: [] };

/** Gilt der Zwischenspeicher noch – nur für denselben Nutzer, dieselbe Rolle und höchstens 60 s? */
export function zwischenspeicherPasst(zs, { admin, nutzer }, jetzt = Date.now()) {
  return !!zs && zs.admin === admin && zs.nutzer === nutzer && jetzt - zs.zeit < 60_000;
}

/** Beim Sitzungsende (Abmelden, anderer Nutzer im selben Tab) nichts vom Vorgänger zeigen. */
export function zwischenspeicherLeeren() { zwischenspeicher = { zeit: 0, admin: null, nutzer: null, eintraege: [] }; }

/** Nur für Tests. */
export const _test = { zwischenspeicher: () => zwischenspeicher };

/** Suchfenster öffnen. `kontext` = {ansichten, admin, nutzer, seitenText, darstellungOeffnen}. */
export function oeffnen(kontext) {
  const feste = festeEintraege(kontext);
  let dynamisch = zwischenspeicherPasst(zwischenspeicher, kontext) ? zwischenspeicher.eintraege : [];
  const eingabe = el('input', { type: 'search', class: 'eingabe suche-eingabe', placeholder: t('suche.platzhalter'), 'aria-label': t('suche.titel'), autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'suche-liste', 'aria-autocomplete': 'list' });
  const liste = el('ul', { class: 'suche-liste', id: 'suche-liste', role: 'listbox' });
  const hinweisZeile = el('p', { class: 'erklaerung suche-hinweis', text: t('suche.tipp') });
  let treffer = []; let auswahl = 0;
  const fenster = dialog([eingabe, liste, hinweisZeile], { titel: t('suche.titel'), klasse: 'suche-dialog' });

  function waehlen(e) {
    fenster.schliessen();
    if (e.aktion === 'darstellung') { kontext.darstellungOeffnen?.(); return; }
    if (location.hash === e.ziel) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = e.ziel;
  }
  function zeichnen() {
    const q = eingabe.value.trim();
    treffer = q ? suchen([...feste, ...dynamisch], q) : feste.filter((e) => e.art === 'seite');
    auswahl = Math.min(auswahl, Math.max(0, treffer.length - 1));
    liste.textContent = '';
    if (!treffer.length) { liste.appendChild(el('li', { class: 'suche-leer', text: t('suche.nichts', { text: q }) })); eingabe.removeAttribute('aria-activedescendant'); return; }
    treffer.forEach((e, i) => {
      const li = el('li', { class: `suche-treffer${i === auswahl ? ' aktiv' : ''}`, id: `suche-treffer-${i}`, role: 'option', 'aria-selected': i === auswahl ? 'true' : 'false',
        onclick: () => waehlen(e), onmousemove: () => { if (auswahl !== i) { auswahl = i; markieren(); } } }, [
        symbol(e.symbol || 'suchen'),
        el('span', { class: 'suche-text' }, [el('span', { class: 'suche-titel', text: e.titel }), e.unter ? el('span', { class: 'suche-unter', text: e.unter }) : null]),
        el('span', { class: 'suche-art', text: t(`suche.art_${e.art}`) }),
      ]);
      liste.appendChild(li);
    });
    markieren();
  }
  function markieren() {
    [...liste.children].forEach((li, i) => { li.classList.toggle('aktiv', i === auswahl); li.setAttribute('aria-selected', i === auswahl ? 'true' : 'false'); });
    eingabe.setAttribute('aria-activedescendant', `suche-treffer-${auswahl}`);
    const akt = liste.children[auswahl]; if (akt && akt.scrollIntoView) akt.scrollIntoView({ block: 'nearest' });
  }
  eingabe.addEventListener('input', () => { auswahl = 0; zeichnen(); });
  eingabe.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); auswahl = Math.min(treffer.length - 1, auswahl + 1); markieren(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); auswahl = Math.max(0, auswahl - 1); markieren(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (treffer[auswahl]) waehlen(treffer[auswahl]); }
  });
  zeichnen();
  eingabe.focus();
  if (!dynamisch.length) {
    dynamischeEintraege(kontext.admin).then((d) => { dynamisch = d; zwischenspeicher = { zeit: Date.now(), admin: kontext.admin, nutzer: kontext.nutzer, eintraege: d }; if (eingabe.isConnected && eingabe.value.trim()) zeichnen(); }).catch(() => {});
  }
  return fenster;
}
