// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ansicht „VMs“ (Teilprojekt 3): virtuelle Maschinen anlegen (ISO aus einer Freigabe), starten/stoppen, ändern, löschen
// und die Konsole im Browser (noVNC aus dem Ubuntu-Paket, Verbindung über /api/vm-konsole mit Einmal-Ticket).

import {
  el, leeren, anhaengen, stilLaden, eingabe, auswahl, feld, schalter, knopf, fehlerzeile, hinweis, leerHinweis, badge, ampel,
  dialogOeffnen, alleDialogeSchliessen, api, fehlerText, melden, bestaetigen, abo, aufgabeStarten, kopfzeile, karte, formatierer, uebersetzer,
} from './verwaltung-hilfen.js';
import { suchzielAnspringen } from './verwaltung-hilfen.js';
import { leerMitSchritt } from './verwaltung-hilfen.js';

let zuletztT = (k) => k;
const abmelder = [];
let uhr = null;

const ZUSTAND = Object.freeze({ laeuft: ['aktiv', 'vms.zustand_laeuft'], pause: ['warnung', 'vms.zustand_pause'], aus: ['inaktiv', 'vms.zustand_aus'], fehler: ['fehler', 'vms.zustand_fehler'], unbekannt: ['unbekannt', 'vms.zustand_unbekannt'] });
const SYSTEM_TEXT = Object.freeze({ linux: 'vms.system_linux', windows: 'vms.system_windows', andere: 'vms.system_andere' });
const NETZ_TEXT = Object.freeze({ nat: 'vms.netz_nat', bruecke: 'vms.netz_bruecke' });

/** Speicher-Auswahl: 1, 2, 4, 8 … GB bis Gesamtspeicher − 1 GB. */
export function ramStufen(hostMb) {
  const max = Math.max(512, hostMb - 1024);
  const aus = [];
  for (const mb of [512, 1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072]) if (mb <= max) aus.push(mb);
  return aus;
}

/** „4 GB“ / „512 MB“. */
export const ramText = (mb) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);

export default {
  id: 'vms',
  symbol: 'vms',
  rolle: 'admin',
  titel(t) { return (typeof t === 'function' ? t : zuletztT)('vms.titel'); },

  async einbinden(wurzel, ctx) {
    suchzielAnspringen(wurzel, ctx.route); // Suche/„Beheben“: #/vms/ziel/<name>
    stilLaden();
    stilLaden(new URL('./vms.css', import.meta.url).href);
    const t = uebersetzer(ctx); zuletztT = t;
    const fmt = formatierer(ctx);
    leeren(wurzel);
    wurzel.classList.add('vm-wurzel');
    const neuKnopf = knopf(t('vms.neu'), { beiKlick: () => neu() });
    const liste = el('div', { klasse: 'vm-liste' }, leerHinweis(t('vms.laden')));
    anhaengen(wurzel, [kopfzeile(t('vms.titel'), t('vms.untertitel'), neuKnopf), liste]);
    let stand = { vms: [], host: { cpus: 2, ram_mb: 4096 } };

    async function laden() {
      let r;
      try { r = await api(ctx, 'vms.liste', {}); } catch (e) { leeren(liste); liste.appendChild(hinweis(fehlerText(e), 'fehler')); return; }
      stand = r && typeof r === 'object' ? r : stand;
      zeichnen();
    }

    function zeichnen() {
      leeren(liste);
      if (stand.kvm === false) liste.appendChild(hinweis(t('vms.kein_kvm'), 'warnung'));
      if (stand.verfuegbar === false) { liste.appendChild(hinweis(t('vms.libvirt_fehlt', { grund: stand.grund || '' }), 'fehler')); neuKnopf.disabled = true; return; }
      neuKnopf.disabled = false;
      const vms = Array.isArray(stand.vms) ? stand.vms : [];
      if (!vms.length) { liste.appendChild(karte(null, leerMitSchritt(t('vms.leer'), t('vms.erste'), () => neu()))); return; }
      for (const v of vms) liste.appendChild(vmKarte(v));
    }

    async function steuern(v, aktion, text) {
      try { await api(ctx, 'vms.steuern', { name: v.name, aktion }); melden(ctx, t(text, { name: v.name }), 'erfolg'); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
      await laden();
    }

    function vmKarte(v) {
      const [amp, ztext] = ZUSTAND[v.zustand] || ZUSTAND.unbekannt;
      const laeuft = v.zustand === 'laeuft' || v.zustand === 'pause';
      const daten = [t('vms.kerne', { n: v.cpu }), ramText(v.ram_mb), v.platte_belegt_gb !== null && v.platte_belegt_gb !== undefined ? t('vms.platte_belegt', { gb: v.platte_belegt_gb }) : null, v.ip ? `IP ${v.ip}` : null, v.autostart ? t('vms.autostart_kurz') : null].filter(Boolean).join(' · ');
      const knoepfe = laeuft
        ? [knopf(t('vms.konsole'), { klein: true, beiKlick: () => konsole(v) }),
          knopf(t('vms.herunterfahren'), { art: 'zweit', klein: true, beiKlick: () => steuern(v, 'herunterfahren', 'vms.gemeldet_herunterfahren') }),
          knopf(t('vms.neustart'), { art: 'zweit', klein: true, beiKlick: () => steuern(v, 'neustart', 'vms.gemeldet_neustart') }),
          knopf(t('vms.ausschalten'), { art: 'gefahr', klein: true, titel: t('vms.ausschalten_titel'), beiKlick: async () => { if (await bestaetigen(ctx, t('vms.ausschalten_frage', { name: v.name }))) steuern(v, 'ausschalten', 'vms.gemeldet_aus'); } })]
        : [knopf(t('vms.starten'), { klein: true, beiKlick: () => steuern(v, 'start', 'vms.gemeldet_start') }),
          knopf(t('vms.bearbeiten'), { art: 'zweit', klein: true, beiKlick: () => bearbeiten(v) }),
          knopf(t('vms.loeschen'), { art: 'gefahr', klein: true, beiKlick: async () => {
            if (!await bestaetigen(ctx, t('vms.loeschen_frage', { name: v.name }))) return;
            try { await api(ctx, 'vms.loeschen', { name: v.name }); melden(ctx, t('vms.geloescht', { name: v.name }), 'erfolg'); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); }
            await laden();
          } })];
      if (laeuft) knoepfe.splice(1, 0, knopf(t('vms.cd'), { art: 'zweit', klein: true, beiKlick: () => cdWechseln(v) }));
      const vmKarte = karte(null,
        el('div', { klasse: 'vm-kopf' }, ampel(amp, t(ztext)), el('h2', { klasse: 'vm-name', text: v.titel ? `${v.titel} (${v.name})` : v.name }), badge(t(ztext), undefined, amp === 'aktiv' ? 'erfolg' : amp === 'fehler' ? 'gefahr' : '')),
        el('p', { klasse: 'vm-daten', text: daten }),
        v.cd ? el('p', { klasse: 'vw-gedaempft', text: t('vms.cd_eingelegt', { iso: v.cd.split('/').pop() }) }) : null,
        el('div', { klasse: 'vw-knopfleiste' }, knoepfe));
      vmKarte.dataset.suchziel = v.name;
      return vmKarte;
    }

    async function isosLaden() { try { const r = await api(ctx, 'vms.isos', {}); return Array.isArray(r) ? r : []; } catch { return []; } }
    /** ISO-Auswahl nach Freigabe gruppiert (Betreiber 12.10.2026: Herkunft der Liste war unklar) – Unterordner im Text. */
    const isoAuswahl = (isos, leerText, wert) => {
      const s = auswahl({ optionen: [{ wert: '', text: leerText }] });
      const gruppen = new Map();
      for (const i of isos) { const fg = String(i.ort).split('/')[0]; if (!gruppen.has(fg)) gruppen.set(fg, []); gruppen.get(fg).push(i); }
      for (const [fg, liste] of [...gruppen.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
        const g = el('optgroup', { attr: { label: t('vms.iso_freigabe', { freigabe: fg }) } });
        for (const i of liste) {
          const ordner = String(i.ort).split('/').slice(1).join('/');
          g.appendChild(el('option', { wert: i.pfad, text: `${i.name}${ordner ? ` – ${ordner}` : ''} (${fmt.groesse(i.groesse)})` }));
        }
        s.appendChild(g);
      }
      s.value = wert || '';
      return s;
    };

    async function neu() {
      const fz = fehlerzeile();
      const isos = await isosLaden();
      const h = stand.host || { cpus: 2, ram_mb: 4096 };
      const name = eingabe({ maxlength: 31, platzhalter: 'allinone', spellcheck: false });
      const titel = eingabe({ maxlength: 60, platzhalter: t('vms.titel_platzhalter') });
      const system = auswahl({ optionen: Object.keys(SYSTEM_TEXT).map((s) => ({ wert: s, text: t(SYSTEM_TEXT[s]) })), wert: 'linux' });
      const iso = isoAuswahl(isos, t('vms.iso_keins'), '');
      const cpu = eingabe({ typ: 'number', min: 1, max: h.cpus, wert: Math.min(2, h.cpus) });
      const stufen = ramStufen(h.ram_mb);
      const ram = auswahl({ optionen: stufen.map((mb) => ({ wert: String(mb), text: ramText(mb) })), wert: String(stufen.includes(2048) ? 2048 : stufen[stufen.length - 1]) });
      const platte = eingabe({ typ: 'number', min: 4, max: 16384, wert: 32 });
      const netz = auswahl({ optionen: Object.keys(NETZ_TEXT).map((n) => ({ wert: n, text: t(NETZ_TEXT[n]) })), wert: 'nat' });
      const firmware = auswahl({ optionen: [{ wert: 'uefi', text: 'UEFI' }, { wert: 'bios', text: 'BIOS' }], wert: 'uefi' });
      const autostart = schalter({ label: t('vms.autostart'), erklaerung: t('vms.autostart_erklaerung'), wert: false });
      const fwFeld = feld({ label: t('vms.firmware'), erklaerung: t('vms.firmware_erklaerung'), eingabe: firmware });
      const winHinweis = hinweis(t('vms.windows_hinweis'), 'info');
      system.addEventListener('change', () => {
        const win = system.value === 'windows';
        fwFeld.hidden = win; winHinweis.hidden = !win;
        if (win) { if (Number(platte.value) < 64) platte.value = 64; if (Number(ram.value) < 4096 && stufen.includes(4096)) ram.value = '4096'; }
      });
      winHinweis.hidden = true;
      if (!isos.length) iso.disabled = false;
      dialogOeffnen({
        ctx, titel: t('vms.neu'), breit: true, schliessenText: t('vms.schliessen'),
        inhalt: el('div', { klasse: 'vm-formular' },
          feld({ label: t('vms.name'), erklaerung: t('vms.name_erklaerung'), eingabe: name }),
          feld({ label: t('vms.titel_feld'), erklaerung: t('vms.titel_erklaerung'), eingabe: titel }),
          feld({ label: t('vms.system'), erklaerung: t('vms.system_erklaerung'), eingabe: system }), winHinweis,
          feld({ label: t('vms.iso'), erklaerung: isos.length ? t('vms.iso_erklaerung') : t('vms.iso_keine_gefunden'), eingabe: iso }),
          feld({ label: t('vms.cpu'), erklaerung: t('vms.cpu_erklaerung', { n: h.cpus }), eingabe: cpu }),
          feld({ label: t('vms.ram'), erklaerung: t('vms.ram_erklaerung', { gesamt: ramText(h.ram_mb) }), eingabe: ram }),
          feld({ label: t('vms.platte'), erklaerung: t('vms.platte_erklaerung'), eingabe: platte }),
          feld({ label: t('vms.netz'), erklaerung: t('vms.netz_erklaerung'), eingabe: netz }), fwFeld,
          autostart.element, fz.element),
        knoepfe: [
          { text: t('vms.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('vms.anlegen'), beiKlick: async (g) => {
            fz.leeren();
            const daten = { name: name.value.trim().toLowerCase(), titel: titel.value.trim(), system: system.value, iso: iso.value, cpu: Number(cpu.value), ram_mb: Number(ram.value), platte_gb: Number(platte.value), netz: netz.value, firmware: firmware.value, autostart: autostart.eingabe.checked };
            g.beschaeftigt(true);
            try {
              await aufgabeStarten(ctx, 'vms.anlegen', daten, { titel: t('vms.neu'), meldung: t('vms.anlegen_laeuft'), abbrechen: t('vms.abbrechen'), schliessen: t('vms.schliessen') });
              g.schliessen(); melden(ctx, t('vms.angelegt', { name: daten.name }), 'erfolg'); await laden();
              const v = (stand.vms || []).find((x) => x.name === daten.name);
              if (v && v.konsole) konsole(v);
            } catch (e) { if (e && e.code !== 'E_ABGEBROCHEN') fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
          } },
        ],
      });
    }

    function bearbeiten(v) {
      const fz = fehlerzeile();
      const h = stand.host || { cpus: 2, ram_mb: 4096 };
      const cpu = eingabe({ typ: 'number', min: 1, max: h.cpus, wert: v.cpu });
      const stufen = ramStufen(h.ram_mb);
      if (!stufen.includes(v.ram_mb)) stufen.push(v.ram_mb);
      const ram = auswahl({ optionen: stufen.sort((a, b) => a - b).map((mb) => ({ wert: String(mb), text: ramText(mb) })), wert: String(v.ram_mb) });
      const autostart = schalter({ label: t('vms.autostart'), erklaerung: t('vms.autostart_erklaerung'), wert: !!v.autostart });
      dialogOeffnen({
        ctx, titel: t('vms.bearbeiten_titel', { name: v.name }), schliessenText: t('vms.schliessen'),
        inhalt: el('div', { klasse: 'vm-formular' }, feld({ label: t('vms.cpu'), erklaerung: t('vms.cpu_erklaerung', { n: h.cpus }), eingabe: cpu }), feld({ label: t('vms.ram'), erklaerung: t('vms.ram_erklaerung', { gesamt: ramText(h.ram_mb) }), eingabe: ram }), autostart.element, fz.element),
        knoepfe: [
          { text: t('vms.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('vms.speichern'), beiKlick: async (g) => {
            fz.leeren(); g.beschaeftigt(true);
            try { await api(ctx, 'vms.aendern', { name: v.name, cpu: Number(cpu.value), ram_mb: Number(ram.value), autostart: autostart.eingabe.checked }); g.schliessen(); melden(ctx, t('vms.gespeichert'), 'erfolg'); await laden(); } catch (e) { fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
          } },
        ],
      });
    }

    async function cdWechseln(v) {
      const fz = fehlerzeile();
      const isos = await isosLaden();
      const iso = isoAuswahl(isos, t('vms.cd_auswerfen'), v.cd || '');
      dialogOeffnen({
        ctx, titel: t('vms.cd_titel', { name: v.name }), schliessenText: t('vms.schliessen'),
        inhalt: el('div', { klasse: 'vm-formular' }, feld({ label: t('vms.iso'), erklaerung: t('vms.cd_erklaerung'), eingabe: iso }), fz.element),
        knoepfe: [
          { text: t('vms.abbrechen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
          { text: t('vms.speichern'), beiKlick: async (g) => {
            fz.leeren(); g.beschaeftigt(true);
            try { await api(ctx, 'vms.aendern', { name: v.name, iso: iso.value }); g.schliessen(); await laden(); } catch (e) { fz.zeigen(fehlerText(e)); } finally { g.beschaeftigt(false); }
          } },
        ],
      });
    }

    async function konsole(v) {
      let ticket;
      try { ticket = await api(ctx, 'vms.konsole', { name: v.name }); } catch (e) { melden(ctx, fehlerText(e), 'fehler'); return; }
      const bild = el('div', { klasse: 'vm-bild' });
      const status = el('p', { klasse: 'erklaerung', attr: { 'aria-live': 'polite' }, text: t('vms.konsole_verbinde') });
      let rfb = null;
      dialogOeffnen({
        ctx, titel: t('vms.konsole_titel', { name: v.name }), breit: true, klasse: 'vm-konsole-dialog', schliessenText: t('vms.schliessen'),
        inhalt: el('div', { klasse: 'vm-konsole' }, status, bild),
        knoepfe: [
          { text: t('vms.strg_alt_entf'), art: 'zweit', beiKlick: () => { try { rfb && rfb.sendCtrlAltDel(); } catch { /* egal */ } } },
          { text: t('vms.vollbild'), art: 'zweit', beiKlick: () => { try { bild.requestFullscreen && bild.requestFullscreen(); } catch { /* egal */ } } },
          { text: t('vms.schliessen'), art: 'zweit', beiKlick: (g) => g.schliessen() },
        ],
        beimSchliessen: () => { try { rfb && rfb.disconnect(); } catch { /* egal */ } },
      });
      try {
        const { default: RFB } = await import('/novnc/core/rfb.js');
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/vm-konsole?ticket=${encodeURIComponent(ticket.ticket)}`;
        rfb = new RFB(bild, url);
        rfb.scaleViewport = true;
        rfb.addEventListener('connect', () => { status.textContent = t('vms.konsole_verbunden'); rfb.focus(); });
        rfb.addEventListener('disconnect', (e) => { status.textContent = e.detail && e.detail.clean ? t('vms.konsole_getrennt') : t('vms.konsole_fehler'); });
      } catch (e) { status.textContent = t('vms.konsole_novnc_fehlt', { fehler: e.message }); }
    }

    abmelder.push(abo(ctx, 'konfig', (e) => { const b = e && (e.bereich || (e.daten && e.daten.bereich)); if (!b || b === 'vms') laden(); }));
    clearInterval(uhr);
    uhr = setInterval(() => { if (!document.hidden && !document.querySelector('.vm-konsole-dialog')) laden(); }, 15_000);
    await laden();
  },

  verlassen() {
    clearInterval(uhr); uhr = null;
    for (const a of abmelder.splice(0)) a();
    alleDialogeSchliessen();
  },
};
