// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „vpn.*“ – WireGuard-VPN-Server auf dem NAS (Betreiber 12.10.2026: „wireguard-VPN server … um das nas aus der
// ferne zugreifen zu können (verwaltbar in den einstellungen)“, dazu ein Selbsttest mit genauer Anleitung bei Sperren).
// Wahrheit ist vpn.json (0600, enthält die Schlüssel); daraus entstehen /etc/wireguard/wg-fahnas.conf (wg-quick@wg-fahnas)
// und – über den Firewall-Renderer – Port, Weiterleitung und NAT. Pakete (wireguard-tools, qrencode) kommen beim
// Einschalten nach.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { paketeSicherstellen, paketeFehlend } from '../helfer/pakete.js';
import { rendereFirewall, appPortsLesen } from '../render/firewall.js';
import * as wg from '../vpn/wireguard.js';
import * as st from '../vpn/selbsttest.js';

export const DATEI = 'vpn.json';
export const PAKETE = Object.freeze(['wireguard-tools', 'qrencode']);
const UNIT = `wg-quick@${wg.SCHNITTSTELLE}`;
const konfPfad = () => process.env.FAHNAS_WG_KONF || `/etc/wireguard/${wg.SCHNITTSTELLE}.conf`;
const sysctlPfad = () => process.env.FAHNAS_SYSCTL_VPN || '/etc/sysctl.d/90-fahnas-vpn.conf';
const BELEGTE_UDP = new Set([53, 67, 68, 123, 137, 138, 5353]);
const TAKT_MS = 60_000;

export function normal(d) {
  const s = structuredClone(wg.STANDARD);
  if (!d || typeof d !== 'object') return s;
  return { ...s, ...d, server: { ...s.server, ...(d.server || {}) }, geraete: Array.isArray(d.geraete) ? d.geraete.filter((g) => g && g.id && g.ip) : [], lan_netze: Array.isArray(d.lan_netze) ? d.lan_netze : [] };
}
const laden = async (w) => normal(await w.konfig.laden(DATEI, null));

/** Ansicht ohne private Schlüssel. */
export function ansicht(c) {
  return {
    aktiv: !!c.aktiv, port: c.port, netz: c.netz, adresse: c.adresse, dns: c.dns, server_ip: wg.cidr(c.netz) ? wg.serverIp(c.netz) : null,
    server_schluessel: c.server.oeffentlich || null, nas_ip: c.nas_ip || null, lan_netze: c.lan_netze,
    geraete: c.geraete.map((g) => ({ id: g.id, name: g.name, ip: g.ip, zugriff: g.zugriff, angelegt: g.angelegt })), selbsttest: c.selbsttest || null,
  };
}

// ---- Umgebung des NAS ---------------------------------------------------------------------------------------------
const VIRTUELL = /^(docker|br-|veth|virbr|vnet|wg|tun|tap|lo)/;

/** Routen auswerten (rein, für Tests): LAN-Netze, NAS-Adresse, Gateway und alle belegten Netze. */
export function routenAuswerten(routen) {
  const r = Array.isArray(routen) ? routen : [];
  const standard = r.find((x) => x.dst === 'default');
  const dev = standard ? standard.dev : null;
  const netze = r.filter((x) => x.dst && x.dst !== 'default' && wg.cidr(x.dst.includes('/') ? x.dst : `${x.dst}/32`));
  const lan = netze.filter((x) => x.dst.includes('/') && x.scope === 'link' && !VIRTUELL.test(x.dev || '') && (!dev || x.dev === dev)).map((x) => wg.cidr(x.dst).text);
  const nasIp = (standard && standard.prefsrc) || (netze.find((x) => x.dev === dev && x.prefsrc) || {}).prefsrc || null;
  const belegt = [...new Set(netze.filter((x) => x.dst.includes('/') && !String(x.dev || '').startsWith('wg')).map((x) => wg.cidr(x.dst).text))];
  return { lan: [...new Set(lan)], nasIp, gateway: standard ? standard.gateway || null : null, belegt };
}

async function umgebung(w) {
  let routen = [];
  try { routen = JSON.parse((await w.system.ausfuehren('ip', ['-j', '-4', 'route', 'show', 'table', 'main'])).stdout || '[]'); } catch { /* leer */ }
  const u = routenAuswerten(routen);
  let dnsServer = [];
  try { dnsServer = [...(await fs.readFile('/run/systemd/resolve/resolv.conf', 'utf8')).matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]); } catch { /* leer */ }
  let nasDns = false;
  try {
    const t = String((await w.system.ausfuehren('ss', ['-Hlnu', 'sport = :53'])).stdout || '');
    nasDns = t.split('\n').some((z) => { const a = (z.trim().split(/\s+/)[3] || '').replace(/%[^:]+/, ''); return a === `${u.nasIp}:53` || a === '0.0.0.0:53' || a === '*:53'; });
  } catch { /* egal */ }
  return { ...u, dnsServer, nasDns };
}

/** Läuft die Schnittstelle? → Dump-Text oder null. */
async function dump(w) {
  try { return String((await w.system.ausfuehren('wg', ['show', wg.SCHNITTSTELLE, 'dump'], { zeitlimit_ms: 10_000 })).stdout || ''); } catch { return null; }
}

async function qrSvg(w, text) {
  try { return String((await w.system.ausfuehren('qrencode', ['-t', 'SVG', '-l', 'M', '-m', '2', '-o', '-'], { eingabe: text, zeitlimit_ms: 10_000 })).stdout || '') || null; } catch { return null; }
}

/** Server-Konfiguration schreiben, Firewall rendern, Dienst starten/aktualisieren oder stoppen. */
async function anwenden(w, c, { neustart = false } = {}) {
  const konf = konfPfad();
  if (c.aktiv) {
    await fs.mkdir(path.dirname(konf), { recursive: true, mode: 0o700 });
    const tmp = `${konf}.neu`;
    await fs.writeFile(tmp, wg.serverKonfig(c), { mode: 0o600 });
    await fs.rename(tmp, konf);
    await fs.writeFile(sysctlPfad(), '# FAH-NAS: VPN-Geräte ins Heimnetz/Internet weiterleiten\nnet.ipv4.ip_forward = 1\n', { mode: 0o644 });
    try { await w.system.ausfuehren('sysctl', ['-q', '-w', 'net.ipv4.ip_forward=1']); } catch { /* Docker setzt es ohnehin */ }
  }
  const sys = await w.konfig.laden('system.json', null);
  await rendereFirewall({ ssh: !(sys && sys.ssh === false) }, { system: w.system });
  if (!c.aktiv) {
    try { await w.system.ausfuehren('systemctl', ['disable', '--now', UNIT]); } catch { /* war nie an */ }
    return;
  }
  const laeuft = (await dump(w)) !== null;
  if (!laeuft || neustart) {
    await w.system.ausfuehren('systemctl', ['enable', UNIT]);
    try { await w.system.ausfuehren('systemctl', ['restart', UNIT], { zeitlimit_ms: 60_000 }); } catch (e) {
      const f = FahnasFehler.aus(e);
      throw new FahnasFehler('E_SYSTEM', 'Der VPN-Dienst ließ sich nicht starten', { ausgabe: f.details?.ausgabe || f.message, befehl: `journalctl -u ${UNIT}` });
    }
  } else {
    // Ubuntus AppArmor-Profil für „wg“ erlaubt nur /etc/wireguard/** (nicht /tmp; /dev/stdin ist bei Node ein Socket)
    const { stdout } = await w.system.ausfuehren('wg-quick', ['strip', wg.SCHNITTSTELLE]);
    const abgleich = path.join(path.dirname(konf), `.${wg.SCHNITTSTELLE}.abgleich`);
    try {
      await fs.writeFile(abgleich, stdout, { mode: 0o600 });
      await w.system.ausfuehren('wg', ['syncconf', wg.SCHNITTSTELLE, abgleich]);
    } finally { await fs.rm(abgleich, { force: true }); }
  }
}

/** Gerät geändert → anwenden; scheitert das, den vorherigen Stand zurückschreiben (Konfiguration = laufender Dienst). */
async function anwendenOderZurueck(w, c, vorher) {
  if (!c.aktiv) return;
  try { await anwenden(w, c); } catch (e) {
    await w.konfig.speichern(DATEI, vorher);
    try { await anwenden(w, vorher); } catch { /* bestmöglich */ }
    throw e;
  }
}

/** Antwort mit Konfiguration + QR-Code für ein Gerät. */
async function geraetAntwort(w, c, g) {
  if (!c.adresse) throw new FahnasFehler('E_PARAMS', 'Bitte zuerst die Adresse von außen eintragen (DynDNS-Name oder öffentliche IP) und speichern', { feld: 'adresse' });
  const u = await umgebung(w);
  const text = wg.geraetKonfig(c, g, { endpunkt: c.adresse, dns: wg.geraetDns(c, g.zugriff, u) });
  return { id: g.id, name: g.name, ip: g.ip, zugriff: g.zugriff, dateiname: wg.dateiname(g.name), text, qr_svg: await qrSvg(w, text) };
}

const S_ZUGRIFF = { typ: 'string', werte: [...wg.ZUGRIFF] };

export function registriere(reg, w) {
  reg.aktion('vpn.lesen', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'VPN-Einstellungen und Geräte (ohne private Schlüssel)',
    ausfuehren: async () => {
      const c = await laden(w);
      let fehlen = [];
      try { fehlen = await paketeFehlend(w.system, PAKETE); } catch { /* egal */ }
      const u = c.nas_ip ? { nasIp: c.nas_ip } : await umgebung(w);
      return { ...ansicht(c), nas_ip: c.nas_ip || u.nasIp || null, laeuft: (await dump(w)) !== null, pakete_fehlen: fehlen };
    },
  });

  reg.aktion('vpn.status', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Verbundene VPN-Geräte (letzter Handshake, Datenmenge)',
    ausfuehren: async () => {
      const c = await laden(w);
      const d = await dump(w);
      const st2 = wg.dumpParsen(d || '');
      const je = new Map(st2.geraete.map((g) => [g.oeffentlich, g]));
      return {
        aktiv: c.aktiv, laeuft: d !== null,
        geraete: c.geraete.map((g) => { const x = je.get(g.oeffentlich) || {}; return { id: g.id, name: g.name, ip: g.ip, zugriff: g.zugriff, verbunden: !!x.verbunden, handshake: x.handshake || null, rx: x.rx || 0, tx: x.tx || 0, endpunkt: x.endpunkt || null }; }),
      };
    },
  });

  reg.aktion('vpn.speichern', {
    rolle: 'admin', aufgabe: true, beschreibung: 'VPN ein-/ausschalten, Port, Netz, Adresse von außen, DNS',
    schema: { aktiv: { typ: 'boolean' }, port: { typ: 'number' }, netz: { typ: 'string', max: 32 }, adresse: { typ: 'string', max: 253 }, dns: { typ: 'string', max: 100 } },
    ausfuehren: async (p, _k, _w, aufgabe) => {
      const alt = await laden(w);
      const c = structuredClone(alt);
      aufgabe?.fortschritt(0.05, 'Einstellungen prüfen');
      if (typeof p.aktiv === 'boolean') c.aktiv = p.aktiv;
      if (p.port !== undefined) {
        const port = Number(p.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || BELEGTE_UDP.has(port)) throw new FahnasFehler('E_PARAMS', 'VPN-Port bitte zwischen 1024 und 65535 wählen (Vorschlag 51821)', { feld: 'port' });
        if ((await appPortsLesen()).some((a) => a.proto === 'udp' && a.port === port)) throw new FahnasFehler('E_PARAMS', `UDP-Port ${port} nutzt schon eine App`, { feld: 'port' });
        c.port = port;
      }
      const u = await umgebung(w);
      if (p.netz !== undefined && wg.cidr(p.netz)?.text !== wg.cidr(alt.netz)?.text) {
        if (alt.geraete.length) throw new FahnasFehler('E_PARAMS', 'Das VPN-Netz lässt sich nur ändern, solange keine Geräte angelegt sind', { feld: 'netz' });
        c.netz = wg.netzPruefen(p.netz, u.belegt.filter((b) => b !== wg.cidr(alt.netz)?.text));
      }
      if (p.adresse !== undefined) c.adresse = wg.adressePruefen(p.adresse);
      if (p.dns !== undefined) c.dns = wg.dnsPruefen(p.dns);
      if (c.aktiv) {
        aufgabe?.fortschritt(0.15, 'Pakete prüfen');
        await paketeSicherstellen(w.system, PAKETE, { fortschritt: (t) => aufgabe?.fortschritt(0.2, t), zweck: 'das VPN' });
      }
      if (!c.server.privat) c.server = wg.schluesselpaar();
      c.lan_netze = u.lan; c.nas_ip = u.nasIp || c.nas_ip;
      aufgabe?.fortschritt(0.7, 'VPN-Dienst einrichten');
      await w.konfig.speichern(DATEI, c);
      const neustart = c.port !== alt.port || c.netz !== alt.netz;
      try { await anwenden(w, c, { neustart }); } catch (e) {
        await w.konfig.speichern(DATEI, alt);
        try { await anwenden(w, alt); } catch { /* bestmöglich zurück */ }
        throw e;
      }
      w.konfigGeaendert?.('vpn');
      aufgabe?.fortschritt(1, c.aktiv ? 'VPN läuft' : 'VPN aus');
      return { ...ansicht(c), laeuft: (await dump(w)) !== null, hinweis: alt.geraete.length && (c.port !== alt.port || c.adresse !== alt.adresse) ? 'Port oder Adresse geändert – bitte die Konfiguration auf den Geräten neu einlesen (QR-Code).' : null };
    },
  });

  reg.aktion('vpn.oeffentliche_ip', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Öffentliche IPv4 des Anschlusses ermitteln',
    ausfuehren: async () => {
      const ip = await st.oeffentlicheIp(fetch);
      if (!ip) throw new FahnasFehler('E_SYSTEM', 'Öffentliche IP nicht ermittelbar – hat das NAS Internet?');
      return { ip };
    },
  });

  reg.aktion('vpn.geraet.anlegen', {
    rolle: 'admin', beschreibung: 'Neues VPN-Gerät (Handy, Laptop) mit Schlüsseln, Konfiguration und QR-Code',
    schema: { name: { typ: 'string', pflicht: true, max: 32 }, zugriff: { ...S_ZUGRIFF, standard: 'nas' } },
    ausfuehren: async (p) => {
      let g; let c; let vorher;
      await w.konfig.aendern(DATEI, (roh) => {
        c = normal(roh); vorher = structuredClone(c);
        if (!c.server.privat) c.server = wg.schluesselpaar();
        const name = wg.namePruefen(p.name);
        if (c.geraete.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new FahnasFehler('E_EXISTIERT', `Ein Gerät „${name}“ gibt es schon`, { feld: 'name' });
        if (c.geraete.length >= 250) throw new FahnasFehler('E_PARAMS', 'Höchstens 250 Geräte');
        g = { id: `g-${crypto.randomBytes(5).toString('hex')}`, name, ip: wg.naechsteIp(c.netz, [wg.serverIp(c.netz), ...c.geraete.map((x) => x.ip)]), zugriff: wg.ZUGRIFF.includes(p.zugriff) ? p.zugriff : 'nas', ...wg.schluesselpaar(), psk: wg.vorabSchluessel(), angelegt: new Date().toISOString() };
        c.geraete.push(g);
        return c;
      }, null, 0o600);
      await anwendenOderZurueck(w, c, vorher);
      w.konfigGeaendert?.('vpn');
      return geraetAntwort(w, c, g);
    },
  });

  reg.aktion('vpn.geraet.aendern', {
    rolle: 'admin', beschreibung: 'Name oder Zugriff eines VPN-Geräts ändern',
    schema: { id: { typ: 'string', pflicht: true, max: 32 }, name: { typ: 'string', max: 32 }, zugriff: S_ZUGRIFF },
    ausfuehren: async (p) => {
      let g; let c; let vorher;
      await w.konfig.aendern(DATEI, (roh) => {
        c = normal(roh); vorher = structuredClone(c);
        g = c.geraete.find((x) => x.id === p.id);
        if (!g) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Gerät nicht gefunden');
        if (p.name !== undefined) {
          const name = wg.namePruefen(p.name);
          if (c.geraete.some((x) => x !== g && x.name.toLowerCase() === name.toLowerCase())) throw new FahnasFehler('E_EXISTIERT', `Ein Gerät „${name}“ gibt es schon`, { feld: 'name' });
          g.name = name;
        }
        if (p.zugriff !== undefined) g.zugriff = p.zugriff;
        return c;
      }, null, 0o600);
      await anwendenOderZurueck(w, c, vorher);
      w.konfigGeaendert?.('vpn');
      return geraetAntwort(w, c, g);
    },
  });

  reg.aktion('vpn.geraet.loeschen', {
    rolle: 'admin', beschreibung: 'VPN-Gerät löschen (sein Schlüssel gilt sofort nicht mehr)',
    schema: { id: { typ: 'string', pflicht: true, max: 32 } },
    ausfuehren: async (p) => {
      let c; let vorher;
      await w.konfig.aendern(DATEI, (roh) => {
        c = normal(roh); vorher = structuredClone(c);
        c.geraete = c.geraete.filter((x) => x.id !== p.id);
        if (c.geraete.length === vorher.geraete.length) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Gerät nicht gefunden');
        return c;
      }, null, 0o600);
      await anwendenOderZurueck(w, c, vorher);
      w.konfigGeaendert?.('vpn');
      return { geloescht: p.id };
    },
  });

  reg.aktion('vpn.geraet.konfig', {
    rolle: 'admin', lesend: true, beschreibung: 'Konfiguration und QR-Code eines VPN-Geräts erneut anzeigen',
    schema: { id: { typ: 'string', pflicht: true, max: 32 } },
    ausfuehren: async (p) => {
      const c = await laden(w);
      const g = c.geraete.find((x) => x.id === p.id);
      if (!g) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Gerät nicht gefunden');
      return geraetAntwort(w, c, g);
    },
  });

  reg.aktion('vpn.apply', {
    rolle: 'system', schema: {}, beschreibung: 'VPN aus vpn.json herstellen (Start, Import)',
    ausfuehren: async () => {
      const c = await laden(w);
      if (!c.aktiv) return false;
      if ((await paketeFehlend(w.system, ['wireguard-tools'])).length) return false;
      await anwenden(w, c);
      return true;
    },
  });

  reg.aktion('vpn.selbsttest', {
    rolle: 'admin', aufgabe: true, schema: {}, beschreibung: 'Prüft Dienst, Firewall, öffentliche Adresse, Anschluss und Erreichbarkeit von außen',
    ausfuehren: async (_p, _k, _w, aufgabe) => {
      const ergebnis = await selbsttest(w, (anteil, text) => aufgabe?.fortschritt(anteil, text));
      await w.konfig.aendern(DATEI, (roh) => ({ ...normal(roh), selbsttest: ergebnis }), null, 0o600);
      return ergebnis;
    },
  });
}

/**
 * Der Selbsttest. Jeder Schritt: {schritt, zustand:'ok'|'warnung'|'fehler'|'info', titel, text, tun?}. „tun“ ist die
 * genaue Handlungsanweisung (Router, Menüpfad, Port, Ziel-IP).
 */
export async function selbsttest(w, fortschritt = () => {}, abh = {}) {
  const holen = abh.holen || fetch;
  const titel = abh.titelHolen || st.titelHolen;
  const c = await laden(w);
  const u = await umgebung(w);
  const nasIp = u.nasIp || c.nas_ip;
  const schritte = [];
  const add = (s) => { schritte.push(s); return s; };
  const ende = () => {
    const gesamt = schritte.some((s) => s.zustand === 'fehler') ? 'fehler' : schritte.some((s) => s.zustand === 'warnung') ? 'warnung' : 'ok';
    return { zeit: new Date().toISOString(), gesamt, schritte };
  };

  // 1) Dienst
  fortschritt(0.05, 'VPN-Dienst prüfen');
  if (!c.aktiv) { add({ schritt: 'dienst', zustand: 'fehler', titel: 'VPN ist ausgeschaltet', text: 'Der VPN-Server ist aus.', tun: 'Oben „VPN-Server“ einschalten und speichern.' }); return ende(); }
  let d = await dump(w);
  if (d === null) { try { await anwenden(w, c, { neustart: true }); } catch { /* unten gemeldet */ } d = await dump(w); }
  const port = wg.dumpParsen(d || '').port;
  if (d === null) { add({ schritt: 'dienst', zustand: 'fehler', titel: 'VPN-Dienst läuft nicht', text: 'Die WireGuard-Schnittstelle wg-fahnas fehlt, auch nach einem Neustart des Dienstes.', tun: `Protokoll ansehen: System → Protokolle (Dienst ${UNIT}).` }); return ende(); }
  add({ schritt: 'dienst', zustand: port === c.port ? 'ok' : 'warnung', titel: 'VPN-Dienst läuft', text: `WireGuard lauscht auf UDP ${port ?? '?'}${port !== c.port ? ` (eingestellt: ${c.port})` : ''}.` });

  // 2) Firewall des NAS
  fortschritt(0.15, 'Firewall des NAS prüfen');
  // Firewall dauerhaft aus (12.10.2026): die Eingangskette lässt alles durch (policy accept) – dann ist das VPN frei;
  // eine ältere Regeldatei mit „policy drop“ braucht weiter die Port-Regel
  const regelDa = async () => { try { const k = String((await w.system.ausfuehren('nft', ['list', 'chain', 'inet', 'fahnas', 'input'])).stdout || ''); return /policy accept/.test(k) || k.includes(`udp dport ${c.port} accept`); } catch { return false; } };
  let fw = await regelDa();
  if (!fw) { try { await anwenden(w, c); } catch { /* unten */ } fw = await regelDa(); }
  add(fw ? { schritt: 'firewall', zustand: 'ok', titel: 'Firewall des NAS lässt das VPN durch', text: `UDP ${c.port} ist im NAS freigegeben.` }
    : { schritt: 'firewall', zustand: 'fehler', titel: 'Firewall des NAS blockiert das VPN', text: `Die Regel für UDP ${c.port} fehlt und ließ sich nicht setzen.`, tun: 'System → Firewall prüfen bzw. FAH-NAS neu starten.' });

  // 3) Öffentliche Adresse
  fortschritt(0.25, 'Öffentliche Adresse ermitteln');
  const oeff = await st.oeffentlicheIp(holen);
  if (!oeff) {
    const v6 = await st.oeffentlicheIp6(holen);
    add(v6 ? { schritt: 'oeffentlich', zustand: 'fehler', titel: 'Keine öffentliche IPv4-Adresse', text: `Der Anschluss geht nur über IPv6 (${v6}) ins Internet – typisch für DS-Lite.`, tun: 'Beim Internetanbieter eine öffentliche IPv4-Adresse bzw. „echtes Dual-Stack“ verlangen (oft kostenlos). Ohne sie kann von außen niemand per IPv4 das NAS erreichen.' }
      : { schritt: 'oeffentlich', zustand: 'fehler', titel: 'Kein Internet', text: 'Das NAS erreicht keinen der Dienste, die die öffentliche Adresse nennen.', tun: 'Internetverbindung und DNS des NAS prüfen (System → Netzwerk).' });
    return ende();
  }
  add({ schritt: 'oeffentlich', zustand: 'ok', titel: 'Öffentliche Adresse', text: `Der Anschluss ist im Internet unter ${oeff} zu sehen.` });

  // 4) Adresse von außen (DynDNS)
  fortschritt(0.35, 'Adresse von außen prüfen');
  if (!c.adresse) add({ schritt: 'adresse', zustand: 'warnung', titel: 'Adresse von außen fehlt', text: 'Die Geräte wissen sonst nicht, wohin sie sich verbinden sollen.', tun: `Oben bei „Adresse von außen“ einen DynDNS-Namen eintragen – oder vorerst die IP ${oeff} (ändert sich bei vielen Anschlüssen regelmäßig).` });
  else if (wg.ipZahl(c.adresse) !== null) add(c.adresse === oeff ? { schritt: 'adresse', zustand: 'warnung', titel: 'Adresse ist eine feste IP', text: `${c.adresse} stimmt im Moment. Wechselt der Anbieter die IP, kommen die Geräte nicht mehr durch.`, tun: 'Besser einen DynDNS-Namen eintragen (z. B. vom Router oder einem DynDNS-Dienst).' }
    : { schritt: 'adresse', zustand: 'fehler', titel: 'Adresse ist veraltet', text: `Eingetragen ist ${c.adresse}, der Anschluss hat aber ${oeff}.`, tun: `Bei „Adresse von außen“ ${oeff} oder besser einen DynDNS-Namen eintragen und die Geräte neu einrichten.` });
  else {
    const ips = await st.dnsVonAussen(holen, c.adresse);
    if (ips === null) add({ schritt: 'adresse', zustand: 'info', titel: 'DNS von außen nicht prüfbar', text: `Ob ${c.adresse} auf ${oeff} zeigt, ließ sich gerade nicht abfragen.` });
    else if (!ips.length) add({ schritt: 'adresse', zustand: 'fehler', titel: `${c.adresse} ist im Internet unbekannt`, text: 'Für den Namen gibt es keinen IPv4-Eintrag.', tun: 'Schreibweise prüfen bzw. den DynDNS-Dienst (Router oder Anbieter) einrichten.' });
    else if (!ips.includes(oeff)) add({ schritt: 'adresse', zustand: 'fehler', titel: `${c.adresse} zeigt auf die falsche Adresse`, text: `Im Internet zeigt der Name auf ${ips.join(', ')}, der Anschluss hat aber ${oeff}.`, tun: 'DynDNS-Aktualisierung im Router bzw. beim DynDNS-Dienst prüfen.' });
    else add({ schritt: 'adresse', zustand: 'ok', titel: 'Adresse von außen stimmt', text: `${c.adresse} zeigt im Internet auf ${oeff}.` });
  }

  // 5) Anschlussart + Router
  fortschritt(0.45, 'Anschluss untersuchen');
  let hops = [];
  try { hops = st.traceParsen((await w.system.ausfuehren('tracepath', ['-n', '-m', '6', '1.1.1.1'], { zeitlimit_ms: 30_000, erlaubteCodes: [0, 1] })).stdout); } catch { /* ohne tracepath */ }
  const anschluss = st.anschlussBewerten(hops, u.gateway);
  const router = u.gateway ? { ip: u.gateway, ...st.routerAusTitel(await titel(u.gateway)) } : { ip: null, art: null, name: null };
  const vorne = anschluss.zweiter ? { ip: anschluss.zweiter, ...st.routerAusTitel(await titel(anschluss.zweiter)) } : null;
  if (anschluss.art === 'cgnat' || anschluss.art === 'dslite') {
    add({ schritt: 'anschluss', zustand: 'fehler', titel: anschluss.art === 'dslite' ? 'Anschluss mit DS-Lite' : 'Anschluss hinter Carrier-NAT', text: 'Der Anschluss hat keine eigene öffentliche IPv4-Adresse – Portweiterleitungen können von außen nicht ankommen.', tun: 'Beim Internetanbieter eine öffentliche IPv4-Adresse bzw. „echtes Dual-Stack“ verlangen (oft kostenlos). Bis dahin geht Fernzugriff nur über einen Tunneldienst.' });
  } else if (anschluss.art === 'doppelnat') {
    add({ schritt: 'anschluss', zustand: 'warnung', titel: 'Zwei Router hintereinander', text: `Vor deinem Router${router.name ? ` (${router.name})` : ''} hängt ein weiterer Router${vorne.name ? ` (${vorne.name})` : ''} mit ${vorne.ip}. Beide müssen den Port weiterreichen.` });
  } else {
    add({ schritt: 'anschluss', zustand: anschluss.art === 'direkt' ? 'ok' : 'info', titel: anschluss.art === 'direkt' ? 'Anschluss geeignet' : 'Anschlussart nicht erkannt', text: `${router.name ? `Router: ${router.name} (${router.ip}). ` : router.ip ? `Router: ${router.ip}. ` : ''}${anschluss.art === 'direkt' ? 'Der Router hat selbst die öffentliche Adresse.' : 'Die Zwischenstationen ließen sich nicht auswerten.'}` });
  }

  // 6) Von außen
  fortschritt(0.55, 'Test von außen (check-host.net) – dauert etwa 20 Sekunden');
  const quellenLesen = async () => { try { return st.quellenParsen((await w.system.ausfuehren('nft', ['-j', 'list', 'set', 'inet', 'fahnas', 'vpn_quellen'])).stdout); } catch { return new Set(); } };
  const a = await st.aussenTest({ holen, ip: oeff, port: c.port, quellenLesen, warten: abh.warten });
  if (a.zustand === 'ok') {
    add({ schritt: 'aussen', zustand: 'ok', titel: 'Von außen erreichbar', text: `Testpakete aus ${a.angekommen.map((k) => k.ort).join(' · ')} sind am NAS angekommen. Geräte können sich von unterwegs verbinden.` });
  } else if (a.zustand === 'unbekannt') {
    add({ schritt: 'aussen', zustand: 'info', titel: 'Test von außen nicht möglich', text: a.fehler, tun: 'Später erneut testen – oder ein Gerät im Mobilfunk (WLAN aus) verbinden: steht es unten auf „verbunden“, ist alles in Ordnung.' });
  } else {
    const tun = [];
    if (anschluss.art !== 'cgnat' && anschluss.art !== 'dslite') {
      if (vorne) tun.push(`Im vorderen Router (${vorne.name || vorne.ip}): ${st.vorneAnleitung({ art: vorne.art, ip: vorne.ip, port: c.port })}`);
      tun.push(`${vorne ? 'Danach in deinem Router' : 'In deinem Router'}${router.name ? ` (${router.name})` : ''}: ${st.weiterleitungsAnleitung({ art: router.art, routerIp: router.ip || 'Router', port: c.port, nasIp })}`);
      tun.push('Läuft im Router selbst schon ein VPN auf demselben Port, dort einen anderen Port wählen – oder hier (Port-Feld oben).');
    }
    add({ schritt: 'aussen', zustand: 'fehler', titel: `UDP ${c.port} ist von außen gesperrt`, text: `Testpakete aus ${a.knoten.map((k) => k.ort).join(' · ') || 'dem Internet'} kamen nicht am NAS an.`, tun: tun.join('\n') || undefined });
  }

  // 7) Feste Adresse des NAS
  const sys = await w.konfig.laden('system.json', null);
  if ((sys?.netz?.modus ?? 'dhcp') === 'dhcp') add({ schritt: 'nas_ip', zustand: 'info', titel: 'Tipp: feste Adresse für das NAS', text: `Das NAS holt seine Adresse (${nasIp}) per DHCP. Ändert sie sich, zeigt die Weiterleitung ins Leere.`, tun: `Im Router für das NAS eine feste Zuordnung (DHCP-Reservierung) auf ${nasIp} anlegen – oder unter System → Netzwerk eine feste Adresse einstellen.` });
  fortschritt(1, 'Fertig');
  return ende();
}

// ---- Takt: Meldungen (Gerät verbunden, Dienst ausgefallen) -----------------------------------------------------------
let takt = null;
const verbunden = new Map();
let ausfall = 0;

export async function taktPruefen(w) {
  const c = await laden(w);
  if (!c.aktiv) { ausfall = 0; return; }
  const d = await dump(w);
  if (d === null) {
    ausfall++;
    if (ausfall === 2) await w.intern('benachrichtigungen.senden', { art: 'vpn', stufe: 'fehler', titel: 'VPN-Server läuft nicht', text: 'Der WireGuard-Dienst ist eingeschaltet, läuft aber nicht. System → VPN → Selbsttest zeigt, was fehlt.', schluessel: 'vpn_ausfall' }).catch(() => {});
    return;
  }
  ausfall = 0;
  const je = new Map(wg.dumpParsen(d).geraete.map((g) => [g.oeffentlich, g]));
  for (const g of c.geraete) {
    const jetzt = !!je.get(g.oeffentlich)?.verbunden;
    if (jetzt && verbunden.get(g.id) === false) await w.intern('benachrichtigungen.senden', { art: 'vpn', stufe: 'info', titel: `VPN: „${g.name}“ verbunden`, text: `Das Gerät „${g.name}“ hat sich per VPN verbunden (von ${je.get(g.oeffentlich).endpunkt || 'unbekannt'}).`, schluessel: `vpn_${g.id}_verbunden` }).catch(() => {});
    verbunden.set(g.id, jetzt);
  }
}

export async function starten(w) {
  takt = setInterval(() => { taktPruefen(w).catch(() => {}); }, TAKT_MS); takt.unref?.();
}
export function stoppen() { if (takt) clearInterval(takt); takt = null; }
