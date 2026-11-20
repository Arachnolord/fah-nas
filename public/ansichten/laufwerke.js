// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „Laufwerke“ (Teilprojekt 2b, externe Laufwerke): Karten je Gerät (Symbol nach Anschluss, Modell, Größe,
// Belegung, Dateisystem, Zustand), Systemplatte grau, Einhängen-Dialog (Name, nur lesen, automatisch, als Freigabe
// mit Erklärtexten und NTFS/exFAT-Hinweis), Auswerfen (bei E_BELEGT Prozessliste), Formatieren (Dateisystem-Wahl mit
// Erklärung, Warnung, Gerätenamen tippen, Aufgabe), S.M.A.R.T., Einstellungen bekannter Geräte, Live über das
// SSE-Ereignis system/art laufwerk. Formen aus docs/schnittstellen.md §12 – tolerant gelesen.

import {
  el, leeren, stilLaden, eingabe, auswahl, feld, schalter, knopf, fehlerzeile, hinweis, leerHinweis, badge, belegungsbalken,
  dialogOeffnen, alleDialogeSchliessen, aufgabeStarten, api, fehlerText, istAdmin, melden, bestaetigen, abo, kopfzeile, uebersetzer, formatierer, felderPruefen, gebiet
} from './verwaltung-hilfen.js';
import { karteRaid } from './raid-karte.js';
import { karteImport } from './import-karte.js';
import { karteSpeicherorte } from './speicherorte-karte.js';
import { karteAnspringen, suchzielAnspringen } from './verwaltung-hilfen.js';

/** Wie der Agent (laufwerke.einhaengen name / Freigabename) */
export const MUSTER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Formatierbare Dateisysteme (laufwerke.formatieren) mit Höchstlänge des Labels (Agent: höchstens 32) und erlaubten Zeichen */
export const FS_FORMATE = Object.freeze([
  { fs: 'exfat', labelMax: 11, erklaerung: 'laufwerke.fs_exfat_erklaerung' },
  { fs: 'ext4', labelMax: 16, erklaerung: 'laufwerke.fs_ext4_erklaerung' },
  { fs: 'btrfs', labelMax: 32, erklaerung: 'laufwerke.fs_btrfs_erklaerung' },
  { fs: 'ntfs', labelMax: 32, erklaerung: 'laufwerke.fs_ntfs_erklaerung' },
]);
/** Wie das Schema des Agenten (D2): Pflicht, beginnt mit Buchstabe/Ziffer, dann Buchstaben, Ziffern, Leerzeichen, - und _ */
export const MUSTER_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
/** Dateisysteme ohne Linux-Rechte (Einhängen mit uid/gid/umask) und nur lesbare */
const OHNE_RECHTE = new Set(['vfat', 'fat', 'fat32', 'exfat', 'ntfs', 'ntfs3', 'ntfs-3g', 'msdos']);
const NUR_LESEN = new Set(['hfsplus', 'hfs']);
const TRAN_TEXT = Object.freeze({ usb: 'laufwerke.tran_usb', sata: 'laufwerke.tran_sata', nvme: 'laufwerke.tran_nvme' });
const SMART_TEXT = Object.freeze({ ok: 'laufwerke.smart_ok', warnung: 'laufwerke.smart_warnung', fehler: 'laufwerke.smart_fehler', unbekannt: 'laufwerke.smart_unbekannt' });
const EREIGNIS_TEXT = Object.freeze({ angesteckt: 'laufwerke.ereignis_angesteckt', eingehaengt: 'laufwerke.ereignis_eingehaengt', entfernt: 'laufwerke.ereignis_entfernt' });
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Einfache Strichsymbole je Anschluss (24×24), damit die Ansicht keine Änderung an symbole.svg braucht */
const SYMBOL_PFADE = Object.freeze({
  usb: ['M9 2h6v6H9z', 'M7 8h10v8a5 5 0 0 1-10 0z', 'M12 16v6', 'M10.5 5h1', 'M12.5 5h1'],
  sata: ['M3 6h18v12H3z', 'M3 14h18', 'M7 17.5h.01', 'M7 10a2 2 0 1 0 4 0a2 2 0 1 0-4 0'],
  nvme: ['M2 8h20v8H2z', 'M6 16v3M10 16v3M14 16v3M18 16v3', 'M6 11h4M14 11h4'],
  sonst: ['M4 5h16v14H4z', 'M4 15h16', 'M8 18h.01', 'M12 10a2.5 2.5 0 1 0 0-.01'],
});

let zuletztT = (k) => ({ 'laufwerke.titel': 'Laufwerke' }[k] || k);
let abmelder = [];

// ---------------------------------------------------------------------------------------------------------------
// Reine Helfer (auch für Tests)

export function listeAus(r, ...schluessel) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') for (const k of [...schluessel, 'geraete', 'laufwerke', 'eintraege']) if (Array.isArray(r[k])) return r[k];
  return [];
}

/** Anschlussart normalisieren: usb | sata | nvme | sonst */
export function tranArt(g) {
  const t = String((g && g.tran) || '').toLowerCase();
  if (t.includes('usb')) return 'usb';
  if (t.includes('nvme')) return 'nvme';
  if (t.includes('sata') || t === 'ata' || t.includes('scsi') || t.includes('sas')) return 'sata';
  return 'sonst';
}

/** Anzeigename eines Geräts: Label, sonst Name/Modell, sonst Gerätepfad */
export function anzeigeName(g) {
  if (!g || typeof g !== 'object') return '';
  return String(g.label || g.name || g.modell || basename(g.pfad) || g.kennung || '').trim();
}

export function basename(pfad) { const p = String(pfad || ''); const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }

/** Namensvorschlag zum Einhängen: aus dem Label, sonst usb-<modell>; auf das Muster gebracht */
export function namenVorschlag(g) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c])).replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  let n = norm(g && g.name && !String(g.name).startsWith('/') && !/^(sd[a-z]\d*|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?)$/.test(g.name) ? g.name : '');
  if (!n) n = norm(g && g.label);
  if (!n) { const m = norm(g && g.modell); n = m ? `usb-${m}` : (g && g.pfad ? `usb-${norm(basename(g.pfad))}` : 'usb'); }
  n = n.slice(0, 32).replace(/[-_]+$/g, '');
  if (!/^[a-z0-9]/.test(n)) n = `usb-${n}`.slice(0, 32).replace(/[-_]+$/g, '');
  return n || 'usb';
}

/** Kennung für aushaengen/aendern: kennung, sonst UUID/PARTUUID, sonst Gerätepfad */
export function kennungVon(g) { return String((g && (g.kennung || g.uuid || g.partuuid || g.pfad)) || ''); }

/** Belegung: {anteil 0..1|null, belegt, frei, gesamt} aus belegt/frei/groesse (fehlende Werte werden ergänzt) */
export function belegung(g) {
  const z = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let belegt = z(g && g.belegt); let frei = z(g && g.frei); let gesamt = z(g && (g.fs_groesse || g.groesse));
  if (belegt !== null && frei !== null && (gesamt === null || gesamt < belegt + frei)) gesamt = belegt + frei;
  if (belegt === null && gesamt !== null && frei !== null) belegt = Math.max(0, gesamt - frei);
  if (frei === null && gesamt !== null && belegt !== null) frei = Math.max(0, gesamt - belegt);
  const anteil = belegt !== null && gesamt ? Math.max(0, Math.min(1, belegt / gesamt)) : null;
  return { anteil, belegt, frei, gesamt };
}

/** Eigenschaften eines Dateisystems: rechte (Linux-Rechte je Datei), nurLesen (nur lesbar), bekannt */
export function fsInfo(fs) {
  const f = String(fs || '').toLowerCase();
  return { fs: f, bekannt: !!f, rechte: !!f && !OHNE_RECHTE.has(f), nurLesen: NUR_LESEN.has(f) };
}

/** Geräte sortieren: externe zuerst (eingehängte vor nicht eingehängten, dann Pfad), Systemgeräte ans Ende */
export function geraeteSortieren(liste) {
  return [...liste].sort((a, b) => {
    const sa = a.system ? 1 : 0; const sb = b.system ? 1 : 0;
    if (sa !== sb) return sa - sb;
    const ma = a.eingehaengt ? 0 : 1; const mb = b.eingehaengt ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return String(a.pfad || '').localeCompare(String(b.pfad || ''), 'de', { numeric: true });
  });
}

/** Prozessliste aus E_BELEGT-Details: prozesse:[{pid, befehl, nutzer}] | Texte | ausgabe (fuser -vm) */
export function prozesseAus(details) {
  const d = details && typeof details === 'object' ? details : {};
  const roh = Array.isArray(d.prozesse) ? d.prozesse : Array.isArray(d.belegt_von) ? d.belegt_von : null;
  if (roh) return roh.map((p) => (p && typeof p === 'object' ? { pid: p.pid ?? p.PID ?? '', befehl: p.befehl || p.name || p.command || p.COMMAND || '', nutzer: p.nutzer || p.user || p.USER || '' } : { pid: '', befehl: String(p), nutzer: '' }));
  // D2 liefert `prozesse` als Text (Ausgabe von fuser -vm), Rückfall ausgabe/grund
  const text = typeof d.prozesse === 'string' ? d.prozesse : typeof d.ausgabe === 'string' ? d.ausgabe : typeof d.grund === 'string' ? d.grund : '';
  const aus = [];
  for (const zeile of text.split('\n')) {
    const m = /^\s*(?:\S+\s+)?(\S+)\s+(\d+)\s+\S*\s+(\S+)/.exec(zeile);
    if (m && /^\d+$/.test(m[2])) aus.push({ pid: m[2], befehl: m[3], nutzer: m[1] });
  }
  return aus.length ? aus : (text.trim() ? [{ pid: '', befehl: text.trim(), nutzer: '' }] : []);
}

/** Laufwerk-Ereignis aus SSE-Daten: {zustand, geraet} oder null (roh oder in daten eingehüllt) */
export function ereignisDaten(e) {
  const d = e && e.daten && typeof e.daten === 'object' && (e.daten.art || e.daten.zustand) ? { ...e, ...e.daten } : e;
  if (!d || typeof d !== 'object') return null;
  if (d.art && d.art !== 'laufwerk') return null;
  const zustand = d.zustand || (d.daten && d.daten.zustand) || '';
  const geraet = (d.geraet && typeof d.geraet === 'object' ? d.geraet : d.daten && d.daten.geraet) || null;
  if (!zustand && !geraet) return null;
  return { zustand: String(zustand), geraet };
}

/** Label-Höchstlänge je Dateisystem */
export function labelMax(fs) { const f = FS_FORMATE.find((x) => x.fs === fs); return f ? f.labelMax : 16; }

// ---------------------------------------------------------------------------------------------------------------

function svgSymbol(art, klasse = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', `symbol ${klasse}`.trim()); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  for (const d of SYMBOL_PFADE[art] || SYMBOL_PFADE.sonst) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
  return svg;
}

export default {
  id: 'laufwerke',
  symbol: 'platte',
  rolle: 'nutzer',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('laufwerke.titel'); },

  async einbinden(wurzel, ctx) {
    stilLaden();
    stilLaden(new URL('./laufwerke.css', import.meta.url).href);
    const t = uebersetzer(ctx); zuletztT = t; const fmt = formatierer(ctx);
    const admin = istAdmin(ctx);
    leeren(wurzel);
    wurzel.classList.add('lw-wurzel');

    const neuKnopf = knopf(t('laufwerke.neu_einlesen'), { art: 'zweit', beiKlick: () => laden() });
    const bereichExtern = el('div', { klasse: 'lw-liste' });
    const bereichSystem = el('div', { klasse: 'lw-liste lw-liste-system' });
    const titelExtern = el('h2', { klasse: 'lw-abschnitt', text: t('laufwerke.abschnitt_extern') }); titelExtern.hidden = true;
    const titelSystem = el('h2', { klasse: 'lw-abschnitt', text: t('laufwerke.abschnitt_system') }); titelSystem.hidden = true;
    wurzel.append(kopfzeile(t('laufwerke.titel'), t(admin ? 'laufwerke.untertitel_admin' : 'laufwerke.untertitel_nutzer'), neuKnopf), titelExtern, bereichExtern, titelSystem, bereichSystem);
    let raidKarte = null;
    let importKarte = null;
    if (admin) {
      raidKarte = karteRaid(ctx, t, fmt); raidKarte.dataset.karte = 'raid'; wurzel.append(raidKarte); // Speicherverbünde (RAID, 12.10.2026); #/laufwerke/raid springt hin
      importKarte = karteImport(ctx, t, fmt); importKarte.dataset.karte = 'import'; wurzel.append(importKarte); // Speicher eines anderen NAS übernehmen (19.10.2026); #/laufwerke/import
      const orteKarte = karteSpeicherorte(ctx, t, fmt); orteKarte.dataset.karte = 'speicherorte'; wurzel.append(orteKarte); // Docker/Apps/VMs auf ein Volume (19.10.2026); #/laufwerke/speicherorte
      karteAnspringen(wurzel, ctx.route);
    }
    suchzielAnspringen(wurzel, ctx.route); // #/laufwerke/ziel/<kennung> („Neue Platte erkannt“ im Handlungsbedarf)

    let geraete = [];
    let ladeLauf = 0;

    async function laden(still = false) {
      const lauf = ++ladeLauf;
      neuKnopf.disabled = true;
      if (!still) { leeren(bereichExtern); bereichExtern.appendChild(leerHinweis(t('laufwerke.laden'))); }
      let r;
      try { r = await api(ctx, 'laufwerke.liste', {}); } catch (e) {
        if (lauf !== ladeLauf) return;
        neuKnopf.disabled = false;
        if (still && geraete.length) return;
        leeren(bereichExtern); bereichExtern.appendChild(hinweis(`${t('laufwerke.lade_fehl')} ${fehlerText(e)}`, 'fehler'));
        return;
      }
      if (lauf !== ladeLauf) return;
      neuKnopf.disabled = false;
      geraete = geraeteSortieren(listeAus(r).filter((g) => g && typeof g === 'object'));
      zeigen();
    }

    function zeigen() {
      leeren(bereichExtern); leeren(bereichSystem);
      const extern = geraete.filter((g) => !g.system); const system = geraete.filter((g) => g.system);
      if (!extern.length) {
        const box = el('div', { klasse: 'leer lw-leer' });
        box.appendChild(svgSymbol('usb', 'gross'));
        box.append(el('p', { klasse: 'leer-titel', text: t('laufwerke.keine') }), el('p', { klasse: 'leer-text', text: t('laufwerke.keine_hinweis') }));
        bereichExtern.appendChild(box);
      } else for (const g of extern) bereichExtern.appendChild(karte(g));
      // Überschriften nur, wenn beide Abschnitte da sind – sonst wirkt eine einzelne Überschrift wie ein Filter
      titelExtern.hidden = !system.length; titelSystem.hidden = !system.length;
      for (const g of system) bereichSystem.appendChild(karte(g));
    }

    function karte(g) {
      const art = tranArt(g);
      const info = fsInfo(g.fs);
      const name = anzeigeName(g) || t('laufwerke.unbekanntes_geraet');
      const badges = el('div', { klasse: 'vw-badges lw-badges' });
      badges.appendChild(badge(t(TRAN_TEXT[art] || 'laufwerke.tran_sonst'), g.tran ? String(g.tran) : undefined));
      badges.appendChild(badge(info.bekannt ? String(g.fs).toUpperCase() : t('laufwerke.fs_kein'), undefined, info.bekannt ? '' : 'warnung'));
      if (g.system) badges.appendChild(badge(t('laufwerke.zustand_system'), t('laufwerke.system_hinweis')));
      else badges.appendChild(badge(t(g.eingehaengt ? 'laufwerke.zustand_eingehaengt' : 'laufwerke.zustand_nicht'), undefined, g.eingehaengt ? 'erfolg' : ''));
      if (g.nur_lesen || (g.optionen && g.optionen.nur_lesen)) badges.appendChild(badge(t('laufwerke.zustand_nur_lesen')));
      if (!g.system && g.bekannt) badges.appendChild(badge(t('laufwerke.zustand_bekannt'), t('laufwerke.zustand_bekannt_titel')));
      if (!g.system && g.automatisch) badges.appendChild(badge(t('laufwerke.zustand_automatisch'), t('laufwerke.zustand_automatisch_titel'), 'akzent'));
      // Freigabe ohne Berechtigte schaltet Samba ab (leeres „valid users“ hieße „jeder“) – deutlich warnen statt „Freigabe“ zeigen
      if (!g.system && g.freigabe) {
        if (g.freigabe_ohne_rechte) badges.appendChild(badge(t('laufwerke.zustand_freigabe_ohne_rechte'), t('laufwerke.freigabe_ohne_rechte_hinweis'), 'warnung'));
        else badges.appendChild(badge(t('laufwerke.zustand_freigabe'), t('laufwerke.zustand_freigabe_titel'), 'akzent'));
      }
      const ohneRechte = !g.system && g.freigabe && g.freigabe_ohne_rechte ? hinweis(t('laufwerke.freigabe_ohne_rechte_hinweis'), 'warnung') : null;

      const b = belegung(g);
      const groesseText = el('p', { klasse: 'lw-groesse vw-gedaempft', text: t('laufwerke.groesse', { groesse: b.gesamt !== null ? fmt.groesse(b.gesamt) : '–' }) });
      const balken = g.eingehaengt && b.anteil !== null
        ? belegungsbalken(b.anteil, `${t('laufwerke.belegt_von', { belegt: fmt.groesse(b.belegt), gesamt: fmt.groesse(b.gesamt), frei: fmt.groesse(b.frei) })} · ${t('laufwerke.belegt_prozent', { prozent: Math.round(b.anteil * 100) })}`)
        : null;
      const ort = g.eingehaengt && g.einhaengepunkt ? el('p', { klasse: 'lw-ort vw-mono vw-gedaempft', text: t('laufwerke.einhaengepunkt', { pfad: g.einhaengepunkt }) }) : null;
      const geraetZeile = el('p', { klasse: 'lw-geraet vw-mono vw-gedaempft', text: t('laufwerke.geraet', { pfad: g.pfad || '–' }) });

      const knoepfe = el('div', { klasse: 'vw-knopfleiste lw-knoepfe' });
      if (admin && !g.system) {
        if (g.eingehaengt) {
          knoepfe.appendChild(knopf(t('laufwerke.auswerfen'), { beiKlick: () => dialogAuswerfen(g) }));
          if (g.bekannt) knoepfe.appendChild(knopf(t('laufwerke.einstellungen'), { art: 'zweit', beiKlick: () => dialogEinstellungen(g) }));
        } else {
          const ein = knopf(t('laufwerke.einhaengen'), { beiKlick: () => dialogEinhaengen(g), deaktiviert: !info.bekannt, titel: info.bekannt ? undefined : t('laufwerke.ohne_fs_hinweis') });
          if (g.bekannt || (g.platte && geraete.some((x) => x !== g && x.platte === g.platte && (x.bekannt || x.eingehaengt)))) knoepfe.appendChild(ein); // neue Platte: „Einbinden“ steht im Kasten „Neue Platte erkannt“
          if (g.bekannt || info.bekannt) knoepfe.appendChild(knopf(t('laufwerke.formatieren'), { art: 'gefahr', beiKlick: () => dialogFormatieren(g) }));
          if (g.bekannt) knoepfe.appendChild(knopf(t('laufwerke.vergessen'), { art: 'zweit', beiKlick: () => vergessen(g) }));
        }
        knoepfe.appendChild(knopf(t('laufwerke.smart'), { art: 'zweit', beiKlick: () => dialogSmart(g) }));
        if (ohneRechte) knoepfe.appendChild(knopf(t('laufwerke.rechte_vergeben'), { beiKlick: () => ctx.navigiere(ctx.hashFuer('freigaben')) }));
      }
      // Geführt (Betreiber 12.10.2026): neue, unbekannte Platte → was soll damit passieren?
      const vertraut = g.platte && geraete.some((x) => x !== g && x.platte === g.platte && (x.bekannt || x.eingehaengt)); // weitere Partition einer bekannten Platte
      const neuWahl = admin && !g.system && !g.bekannt && !g.eingehaengt && !vertraut ? el('div', { klasse: 'lw-neu' },
        el('p', { klasse: 'lw-neu-titel', text: t('laufwerke.neu_frage') }),
        el('div', { klasse: 'lw-neu-wege' },
          knopf(t(info.bekannt ? 'laufwerke.neu_einbinden' : 'laufwerke.neu_formatieren'), { beiKlick: () => (info.bekannt ? dialogEinhaengen(g) : dialogFormatieren(g)) }),
          raidKarte && g.tran !== 'usb' && g.platte ? knopf(t('laufwerke.neu_verbund'), { art: 'zweit', beiKlick: () => {
            raidKarte.scrollIntoView({ behavior: 'smooth', block: 'start' }); raidKarte.neuMitPlatte(String(g.platte).replace(/^\/dev\//, ''));
          } }) : null,
          info.bekannt ? knopf(t('laufwerke.neu_sicherung'), { art: 'zweit', beiKlick: () => dialogEinhaengen(g, { freigabe: true, danach: (n) => ctx.navigiere(ctx.hashFuer('spiegelung', 'neu', n)) }) }) : null),
        el('p', { klasse: 'erklaerung', text: t('laufwerke.neu_erklaerung') })) : null;
      return el('section', { klasse: `karte vw-karte lw-karte lw-${art}${g.system ? ' lw-system' : ''}${g.eingehaengt ? ' lw-eingehaengt' : ''}`, daten: { pfad: g.pfad || '', suchziel: g.kennung || '' } },
        el('div', { klasse: 'lw-kopf' },
          el('div', { klasse: 'lw-symbol' }, svgSymbol(art, 'gross')),
          el('div', { klasse: 'lw-kopf-text' }, el('h2', { klasse: 'lw-titel', text: name }), g.modell && g.modell !== name ? el('p', { klasse: 'lw-modell vw-gedaempft', text: String(g.modell) }) : null, geraetZeile)),
        badges, groesseText, balken, ort, ohneRechte,
        g.system ? el('p', { klasse: 'lw-hinweis vw-gedaempft', text: t('laufwerke.system_hinweis') }) : null,
        !g.system && !info.bekannt ? hinweis(t('laufwerke.ohne_fs_hinweis'), 'warnung') : null,
        neuWahl,
        knoepfe.childNodes.length ? knoepfe : null);
    }

    function aufgabenTexte(titel, meldung) {
      return { titel, meldung, abbrechen: t('laufwerke.aufgabe_abbrechen'), schliessen: t('laufwerke.schliessen'), fehler: (m) => t('laufwerke.aufgabe_fehl', { meldung: m }), abgebrochen: t('laufwerke.aufgabe_abgebrochen') };
    }

    // ---- Einhängen -------------------------------------------------------------------------------------------------
    function dialogEinhaengen(g, { freigabe: freigabeVorgabe = null, danach = null } = {}) {
      const info = fsInfo(g.fs);
      const fsName = String(g.fs || '').toUpperCase();
      const form = el('form', { klasse: 'lw-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const name = eingabe({ wert: g.bekannt && g.name && MUSTER_NAME.test(String(g.name)) ? g.name : namenVorschlag(g), maxlength: 32, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      name.setAttribute('autocapitalize', 'none');
      const nurLesen = schalter({ label: t('laufwerke.nur_lesen'), erklaerung: info.nurLesen ? t('laufwerke.nur_lesen_hfsplus') : t('laufwerke.nur_lesen_erklaerung'), wert: info.nurLesen || !!(g.optionen && g.optionen.nur_lesen) || !!g.nur_lesen });
      if (info.nurLesen) nurLesen.eingabe.disabled = true;
      const automatisch = schalter({ label: t('laufwerke.automatisch'), erklaerung: t('laufwerke.automatisch_erklaerung'), wert: g.automatisch !== undefined && g.bekannt ? !!g.automatisch : true });
      const freigabe = schalter({ label: t('laufwerke.freigabe'), erklaerung: t('laufwerke.freigabe_erklaerung'), wert: freigabeVorgabe ?? !!g.freigabe });
      const rechteHinweis = info.bekannt ? hinweis(t(info.rechte ? 'laufwerke.hinweis_mit_rechten' : 'laufwerke.hinweis_ohne_rechte', { fs: fsName }), info.rechte ? 'info' : 'warnung') : null;
      form.append(fz.element, el('p', { klasse: 'erklaerung', text: t('laufwerke.einhaengen_erklaerung') }),
        feld({ label: t('laufwerke.name'), erklaerung: t('laufwerke.name_erklaerung'), eingabe: name }),
        rechteHinweis, nurLesen.element, automatisch.element, freigabe.element);
      const griff = dialogOeffnen({ ctx, titel: t('laufwerke.einhaengen_titel', { name: anzeigeName(g) || g.pfad }), inhalt: form, schliessenText: t('laufwerke.schliessen'),
        knoepfe: [{ text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (gr) => gr.schliessen() }, { text: t('laufwerke.einhaengen_knopf'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!felderPruefen([{ eingabe: name, pruefen: (w) => (MUSTER_NAME.test(w.trim()) ? null : t('laufwerke.name_fehler')) }], fz)) return;
        griff.beschaeftigt(true);
        const n = name.value.trim();
        try {
          await api(ctx, 'laufwerke.einhaengen', { pfad: g.pfad, name: n, nur_lesen: nurLesen.eingabe.checked, automatisch: automatisch.eingabe.checked, freigabe: freigabe.eingabe.checked });
          melden(ctx, t('laufwerke.eingehaengt_meldung', { name: n }), 'erfolg');
          griff.schliessen();
          await laden(true);
          if (danach) danach(n);
        } catch (e) {
          griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); form.scrollTop = 0;
          if (e && e.details && e.details.feld === 'name') name.focus();
        }
      });
    }

    // ---- Auswerfen -----------------------------------------------------------------------------------------------------
    function dialogAuswerfen(g) {
      const form = el('form', { klasse: 'lw-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const vergessenS = schalter({ label: t('laufwerke.auswerfen_vergessen'), erklaerung: t('laufwerke.auswerfen_vergessen_erklaerung'), wert: false });
      const belegtBox = el('div', { klasse: 'lw-belegt' }); belegtBox.hidden = true;
      form.append(fz.element, el('p', { text: t('laufwerke.auswerfen_erklaerung') }), vergessenS.element, belegtBox);
      const griff = dialogOeffnen({ ctx, titel: t('laufwerke.auswerfen_titel', { name: anzeigeName(g) || g.pfad }), inhalt: form, schliessenText: t('laufwerke.schliessen'),
        knoepfe: [{ text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (gr) => gr.schliessen() }, { text: t('laufwerke.auswerfen_knopf'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        griff.beschaeftigt(true); belegtBox.hidden = true; leeren(belegtBox); fz.leeren();
        try {
          await api(ctx, 'laufwerke.aushaengen', { kennung: kennungVon(g), vergessen: vergessenS.eingabe.checked });
          melden(ctx, t(vergessenS.eingabe.checked ? 'laufwerke.vergessen_meldung' : 'laufwerke.ausgeworfen', { name: anzeigeName(g) || g.pfad }), 'erfolg');
          griff.schliessen();
          await laden(true);
        } catch (e) {
          griff.beschaeftigt(false);
          if (e && e.code === 'E_BELEGT') {
            belegtBox.hidden = false;
            belegtBox.append(hinweis(t('laufwerke.belegt_titel'), 'warnung'), el('p', { klasse: 'erklaerung', text: t('laufwerke.belegt_erklaerung') }));
            const prozesse = prozesseAus(e.details);
            if (prozesse.length) belegtBox.appendChild(el('ul', { klasse: 'lw-prozesse vw-mono' }, prozesse.map((p) => el('li', { text: p.pid ? t('laufwerke.belegt_prozess', { pid: p.pid, befehl: [p.befehl, p.nutzer ? `(${p.nutzer})` : ''].filter(Boolean).join(' ') }) : p.befehl }))));
            else fz.zeigen(fehlerText(e));
          } else fz.zeigen(fehlerText(e));
        }
      });
    }

    async function vergessen(g) {
      if (!(await bestaetigen(ctx, t('laufwerke.vergessen_frage', { name: anzeigeName(g) || g.pfad })))) return;
      try { await api(ctx, 'laufwerke.aushaengen', { kennung: kennungVon(g), vergessen: true }); melden(ctx, t('laufwerke.vergessen_meldung', { name: anzeigeName(g) || g.pfad }), 'erfolg'); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
      await laden(true);
    }

    // ---- Einstellungen bekannter Geräte ----------------------------------------------------------------------------------
    function dialogEinstellungen(g) {
      const form = el('form', { klasse: 'lw-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const info = fsInfo(g.fs);
      const nurLesen = schalter({ label: t('laufwerke.nur_lesen'), erklaerung: info.nurLesen ? t('laufwerke.nur_lesen_hfsplus') : t('laufwerke.nur_lesen_erklaerung'), wert: info.nurLesen || !!(g.optionen && g.optionen.nur_lesen) || !!g.nur_lesen });
      if (info.nurLesen) nurLesen.eingabe.disabled = true;
      const automatisch = schalter({ label: t('laufwerke.automatisch'), erklaerung: t('laufwerke.automatisch_erklaerung'), wert: !!g.automatisch });
      const freigabe = schalter({ label: t('laufwerke.freigabe'), erklaerung: t('laufwerke.freigabe_erklaerung'), wert: !!g.freigabe });
      form.append(fz.element, el('p', { klasse: 'erklaerung', text: t('laufwerke.einstellungen_erklaerung') }), automatisch.element, freigabe.element, nurLesen.element);
      const griff = dialogOeffnen({ ctx, titel: t('laufwerke.einstellungen_titel', { name: anzeigeName(g) || g.pfad }), inhalt: form, schliessenText: t('laufwerke.schliessen'),
        knoepfe: [{ text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (gr) => gr.schliessen() }, { text: t('laufwerke.speichern'), absenden: true }] });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        griff.beschaeftigt(true);
        try {
          await api(ctx, 'laufwerke.aendern', { kennung: kennungVon(g), automatisch: automatisch.eingabe.checked, freigabe: freigabe.eingabe.checked, nur_lesen: nurLesen.eingabe.checked });
          melden(ctx, t('laufwerke.gespeichert', { name: anzeigeName(g) || g.pfad }), 'erfolg');
          griff.schliessen();
          await laden(true);
        } catch (e) { griff.beschaeftigt(false); fz.zeigen(fehlerText(e)); }
      });
    }

    // ---- Formatieren --------------------------------------------------------------------------------------------------------
    function dialogFormatieren(g) {
      const form = el('form', { klasse: 'lw-form', attr: { novalidate: 'novalidate' } });
      const fz = fehlerzeile();
      const fsWahl = auswahl({ optionen: FS_FORMATE.map((f) => ({ wert: f.fs, text: f.fs.toUpperCase() })), wert: 'exfat' });
      const fsErklaerung = el('p', { klasse: 'erklaerung lw-fs-erklaerung' });
      const label = eingabe({ wert: String(g.label || '').slice(0, 11), maxlength: 32, spellcheck: false, autocomplete: 'off' });
      const tipp = eingabe({ maxlength: 64, spellcheck: false, klasse: 'vw-mono', autocomplete: 'off' });
      tipp.setAttribute('autocapitalize', 'none');
      const geraetName = basename(g.pfad) || String(g.pfad || '');
      const aktuell = () => FS_FORMATE.find((f) => f.fs === fsWahl.value) || FS_FORMATE[0];
      const fsZeigen = () => { fsErklaerung.textContent = t(aktuell().erklaerung); label.setAttribute('maxlength', String(aktuell().labelMax)); };
      fsWahl.addEventListener('change', fsZeigen); fsZeigen();
      form.append(fz.element,
        hinweis(t('laufwerke.formatieren_warnung', { pfad: g.pfad || geraetName }), 'fehler'),
        el('div', { klasse: 'feld vw-feld' }, el('label', { klasse: 'feld-beschriftung vw-label', fuer: fsWahl.id, text: t('laufwerke.formatieren_fs') }), fsWahl, el('p', { klasse: 'erklaerung', text: t('laufwerke.formatieren_fs_erklaerung') }), fsErklaerung),
        feld({ label: t('laufwerke.formatieren_label'), erklaerung: t('laufwerke.formatieren_label_erklaerung'), eingabe: label }),
        feld({ label: t('laufwerke.formatieren_tippen'), erklaerung: t('laufwerke.formatieren_tippen_erklaerung', { name: geraetName }), eingabe: tipp }));
      const griff = dialogOeffnen({ ctx, titel: t('laufwerke.formatieren_titel', { name: anzeigeName(g) || g.pfad }), inhalt: form, schliessenText: t('laufwerke.schliessen'),
        knoepfe: [{ text: t('laufwerke.abbrechen'), art: 'zweit', beiKlick: (gr) => gr.schliessen() }, { text: t('laufwerke.formatieren_knopf'), art: 'gefahr', absenden: true, deaktiviert: true }] });
      const formatKnopf = griff.knoepfe[1];
      const passt = () => { const w = tipp.value.trim(); return w !== '' && (w === geraetName || w === String(g.pfad || '')); };
      tipp.addEventListener('input', () => { formatKnopf.disabled = !passt(); });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!passt()) return;
        const f = aktuell();
        if (!felderPruefen([{ eingabe: label, pruefen: (w) => (w.trim().length >= 1 && MUSTER_LABEL.test(w.trim()) && w.trim().length <= f.labelMax ? null : t('laufwerke.formatieren_label_fehler', { max: f.labelMax, fs: f.fs.toUpperCase() })) }], fz)) return;
        griff.beschaeftigt(true);
        try {
          // `bestaetigung` = Gerätepfad (Agent D2 prüft Gleichheit mit `pfad`); die Oberfläche hat den getippten Namen schon geprüft
          await aufgabeStarten(ctx, 'laufwerke.formatieren', { pfad: g.pfad, fs: f.fs, label: label.value.trim(), bestaetigung: g.pfad }, aufgabenTexte(t('laufwerke.formatieren_titel', { name: anzeigeName(g) || g.pfad }), t('laufwerke.formatieren_laeuft')));
          melden(ctx, t('laufwerke.formatiert', { name: label.value.trim() || geraetName, fs: f.fs.toUpperCase() }), 'erfolg');
          griff.schliessen();
          await laden(true);
        } catch (e) { griff.beschaeftigt(false); formatKnopf.disabled = !passt(); if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); }
      });
    }

    // ---- S.M.A.R.T. ----------------------------------------------------------------------------------------------------------
    async function dialogSmart(g) {
      const inhalt = el('div', {}, leerHinweis(t('laufwerke.smart_laden')));
      dialogOeffnen({ ctx, titel: t('laufwerke.smart_titel', { name: anzeigeName(g) || g.pfad }), inhalt, schliessenText: t('laufwerke.schliessen'),
        knoepfe: [{ text: t('laufwerke.schliessen'), art: 'zweit', beiKlick: (gr) => gr.schliessen() }] });
      try {
        const r = await api(ctx, 'laufwerke.smart', { pfad: g.pfad });
        const s = Array.isArray(r) ? (r[0] || {}) : (r && typeof r === 'object' ? (r.smart && typeof r.smart === 'object' ? r.smart : r) : {});
        leeren(inhalt);
        const zustand = String(s.zustand || '').toLowerCase();
        const kv = el('dl', { klasse: 'vw-kv lw-smart' });
        const zeile = (k, v) => { if (v === undefined || v === null || v === '') return; kv.append(el('dt', { text: k }), el('dd', {}, v instanceof Node ? v : String(v))); };
        zeile(t('laufwerke.smart_geraet'), s.geraet || g.pfad);
        zeile(t('laufwerke.smart_modell'), s.modell || g.modell);
        if (SMART_TEXT[zustand]) zeile(t('laufwerke.smart_zustand'), badge(t(SMART_TEXT[zustand]), undefined, zustand === 'ok' ? 'erfolg' : zustand === 'warnung' ? 'warnung' : zustand === 'unbekannt' ? '' : 'gefahr'));
        else if (zustand) zeile(t('laufwerke.smart_zustand'), zustand);
        zeile(t('laufwerke.smart_temperatur'), Number.isFinite(Number(s.temperatur)) && s.temperatur !== null ? `${Number(s.temperatur).toLocaleString(gebiet())} °C` : undefined);
        zeile(t('laufwerke.smart_stunden'), Number.isFinite(Number(s.stunden)) && s.stunden !== null ? Number(s.stunden).toLocaleString(gebiet()) : undefined);
        inhalt.appendChild(kv);
        const d = s.details;
        if (d && typeof d === 'object') {
          const hin = d.hinweis; const rest = { ...d }; delete rest.hinweis;
          if (hin) inhalt.appendChild(hinweis(`${t('laufwerke.smart_hinweis')}: ${hin}`, 'info'));
          const eintraege = Object.entries(rest);
          if (eintraege.length) {
            const dl = el('dl', { klasse: 'vw-kv lw-smart-details' });
            for (const [k, v] of eintraege) {
              const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
              dl.append(el('dt', { text: k }), text.length > 80 || text.includes('\n') ? el('dd', {}, el('pre', { klasse: 'lw-smart-ausgabe', text })) : el('dd', { text }));
            }
            inhalt.appendChild(el('details', { klasse: 'vw-details', attr: { open: 'open' } }, el('summary', { text: t('laufwerke.smart_details') }), dl));
          }
        } else if (typeof d === 'string' && d.trim()) inhalt.appendChild(el('details', { klasse: 'vw-details' }, el('summary', { text: t('laufwerke.smart_details') }), el('pre', { text: d })));
      } catch (e) { leeren(inhalt); inhalt.appendChild(hinweis(`${t('laufwerke.smart_fehl')} ${fehlerText(e)}`, 'warnung')); }
    }

    // ---- Start, Ereignisse --------------------------------------------------------------------------------------------------
    await laden();
    let ladeTimer = null;
    const spaeterLaden = () => { clearTimeout(ladeTimer); ladeTimer = setTimeout(() => laden(true), 400); };
    abmelder.push(() => clearTimeout(ladeTimer));
    // udev meldet je Platte und Partition (sdb, sdb1) – gleiche Meldung innerhalb von 2 s nur einmal zeigen
    let letzterToast = { schluessel: '', zeit: 0 };
    abmelder.push(abo(ctx, 'system', (e) => {
      const d = ereignisDaten(e);
      if (!d) return;
      const name = d.geraet ? (anzeigeName(d.geraet) || d.geraet.pfad) : '';
      const schluessel = `${d.zustand}|${name}`;
      if (EREIGNIS_TEXT[d.zustand] && !(schluessel === letzterToast.schluessel && Date.now() - letzterToast.zeit < 2000)) {
        melden(ctx, t(EREIGNIS_TEXT[d.zustand], { name: name || t('laufwerke.unbekanntes_geraet') }), d.zustand === 'entfernt' ? 'info' : 'erfolg');
        letzterToast = { schluessel, zeit: Date.now() };
      }
      spaeterLaden();
    }));
    abmelder.push(abo(ctx, 'konfig', (e) => { const d = e && e.daten ? e.daten : e; if (!d || !d.bereich || d.bereich === 'laufwerke' || d.bereich === 'freigaben') spaeterLaden(); }));
  },

  /** Gleiche Ansicht, anderes Sprungziel (Dashboard-Kachel „Speicherverbünde“ → #/laufwerke/raid). */
  navigieren(route) { const w = document.querySelector('.lw-wurzel'); if (!suchzielAnspringen(w, route)) karteAnspringen(w, route); },

  verlassen() {
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
  },
};
