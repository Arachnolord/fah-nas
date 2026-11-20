// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „benachrichtigungen.*“ (Betreiber 12.10.2026): E-Mail und ntfy-Push bei Platte voll / SMART-Warnung,
// fehlgeschlagener Spiegelung, abgestürzter App, Updates (und später USV, VPN, VMs). Einstellungen in
// benachrichtigungen.json (0600, Passwörter gehen nie an die Oberfläche), Verlauf der letzten 50 Meldungen.
// Quellen: Ereignisse des Steuerdienstes (werkzeuge.beobachten) und zwei Takte (Apps je Minute, SMART alle 6 Stunden).

import os from 'node:os';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { ARTEN, STUFEN, emailSenden, ntfySenden, meldungAusEreignis, appProblem } from '../benachrichtigung/senden.js';
import { persoenlichSenden, persoenlichServer } from '../benachrichtigung/persoenlich.js';

export const DATEI = 'benachrichtigungen.json';
export const VERLAUF = 'benachrichtigungen-verlauf.json';
const VERLAUF_MAX = 50;
const DOPPELT_MS = 6 * 3_600_000;          // dieselbe Meldung (schluessel) höchstens alle 6 Stunden
const APPS_TAKT_MS = 60_000;
const SMART_TAKT_MS = 6 * 3_600_000;
const SMART_ERSTER_MS = 5 * 60_000;
const MAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const STANDARD = Object.freeze({
  version: 1,
  email: { aktiv: false, server: '', port: 587, sicherheit: 'starttls', benutzer: '', passwort: '', absender: '', empfaenger: [] },
  ntfy: { aktiv: false, server: 'https://ntfy.sh', thema: '', token: '', benutzer: '', passwort: '' },
  ereignisse: { platte: true, spiegelung: true, apps: true, updates: true, usv: true, energie: true, vpn: false, vms: true, anmeldung: true },
});

const zuletzt = new Map(); // schluessel → ms der letzten Meldung
const anmeldeMeldungen = []; // Zeitpunkte der Anmelde-Meldungen der letzten Stunde (Deckel 30)
// Sperren bündeln (Betreiber 16.10.2026: ntfy.sh erlaubt 250 Nachrichten am Tag): die erste Sperre geht sofort hinaus, alle
// weiteren innerhalb einer Stunde kommen gesammelt in EINER Meldung am Ende der Stunde.
const sperrBuendel = { fenster_ms: 3_600_000, letzte: 0, offen: [], timer: null };
const SAMMEL_ZEILEN = 10;
let abmelden = null; let appsTimer = null; let smartTimer = null; let smartErster = null;
const appsZustand = new Map(); // name → {schlecht: n, gemeldet: bool}
const smartZustand = new Map(); // geraet → zuletzt gemeldeter Zustand

function normal(d) {
  const s = structuredClone(STANDARD);
  if (!d || typeof d !== 'object') return s;
  return { version: 1, email: { ...s.email, ...(d.email || {}) }, ntfy: { ...s.ntfy, ...(d.ntfy || {}) }, ereignisse: { ...s.ereignisse, ...(d.ereignisse || {}) } };
}
async function laden(w) { return normal(await w.konfig.laden(DATEI, null)); }

/** Ansicht für die Oberfläche: Passwörter/Token nur als „gesetzt“. */
export function ansicht(c) {
  const { passwort: ep, ...email } = c.email; const { passwort: np, token, ...ntfy } = c.ntfy;
  return { email: { ...email, passwort_gesetzt: !!ep }, ntfy: { ...ntfy, token_gesetzt: !!token, passwort_gesetzt: !!np }, ereignisse: c.ereignisse };
}

/** Eingaben prüfen; leere Geheimnisse bleiben, wie sie sind. */
export function eingabePruefen(p, alt) {
  const fehler = (t, feld) => new FahnasFehler('E_PARAMS', t, { feld });
  const e = { ...alt.email, ...(p.email || {}) };
  if (p.email && (p.email.passwort === undefined || p.email.passwort === '')) e.passwort = alt.email.passwort;
  e.server = String(e.server || '').trim(); e.absender = String(e.absender || '').trim(); e.benutzer = String(e.benutzer || '').trim();
  e.empfaenger = (Array.isArray(e.empfaenger) ? e.empfaenger : String(e.empfaenger || '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  e.port = Number(e.port) || (e.sicherheit === 'tls' ? 465 : 587);
  if (!['starttls', 'tls', 'keine'].includes(e.sicherheit)) e.sicherheit = 'starttls';
  if (e.aktiv) {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(e.server)) throw fehler('E-Mail: bitte den SMTP-Server eintragen (z. B. smtp.gmail.com)', 'email.server');
    if (!MAIL.test(e.absender)) throw fehler('E-Mail: Absenderadresse ist ungültig', 'email.absender');
    if (!e.empfaenger.length || e.empfaenger.some((x) => !MAIL.test(x))) throw fehler('E-Mail: bitte gültige Empfänger eintragen', 'email.empfaenger');
    if (e.port < 1 || e.port > 65535) throw fehler('E-Mail: Port 1–65535', 'email.port');
  }
  const n = { ...alt.ntfy, ...(p.ntfy || {}) };
  if (p.ntfy && (p.ntfy.token === undefined || p.ntfy.token === '')) n.token = alt.ntfy.token;
  if (p.ntfy && (p.ntfy.passwort === undefined || p.ntfy.passwort === '')) n.passwort = alt.ntfy.passwort;
  n.server = String(n.server || '').trim().replace(/\/+$/, ''); n.thema = String(n.thema || '').trim(); n.benutzer = String(n.benutzer || '').trim();
  if (n.aktiv) {
    if (!/^https?:\/\/[^\s/]+/.test(n.server)) throw fehler('ntfy: Server-Adresse mit http:// oder https:// eintragen', 'ntfy.server');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n.thema)) throw fehler('ntfy: Thema aus Buchstaben, Ziffern, - und _ (z. B. fah-nas)', 'ntfy.thema');
  }
  const ereignisse = { ...alt.ereignisse };
  for (const a of ARTEN) if (p.ereignisse && typeof p.ereignisse[a] === 'boolean') ereignisse[a] = p.ereignisse[a];
  return { version: 1, email: e, ntfy: n, ereignisse };
}

/**
 * Meldung verschicken (an alle eingeschalteten Kanäle) und im Verlauf merken. Doppelte (gleicher schluessel innerhalb von
 * 6 Stunden) und abgeschaltete Arten werden übergangen. Nie werfen – Fehler eines Kanals stehen im Verlauf.
 */
export async function melden(w, m, { erzwingen = false, jetzt = Date.now() } = {}) {
  try {
    const c = await laden(w);
    if (!erzwingen && m.art && c.ereignisse[m.art] === false) return null;
    if (!erzwingen && m.schluessel && jetzt - (zuletzt.get(m.schluessel) || 0) < DOPPELT_MS) return null;
    if (m.schluessel) zuletzt.set(m.schluessel, jetzt);
    const rechner = os.hostname();
    const kanaele = {};
    if (c.email.aktiv) {
      try { await emailSenden(w.system, c.email, { betreff: `[${rechner}] ${m.titel}`, text: `${m.text}\n\n— FAH-NAS auf ${rechner}`, rechner }); kanaele.email = 'ok'; } catch (e) { kanaele.email = FahnasFehler.aus(e).message; }
    }
    if (c.ntfy.aktiv) {
      try { await ntfySenden(c.ntfy, { titel: `${rechner}: ${m.titel}`, text: m.text, stufe: m.stufe }); kanaele.ntfy = 'ok'; } catch (e) { kanaele.ntfy = FahnasFehler.aus(e).message; }
    }
    const eintrag = { zeit: new Date(jetzt).toISOString(), art: m.art || 'test', stufe: STUFEN.includes(m.stufe) ? m.stufe : 'info', titel: m.titel, text: m.text, kanaele };
    await w.konfig.aendern(VERLAUF, (v) => [eintrag, ...(Array.isArray(v) ? v : [])].slice(0, VERLAUF_MAX), []);
    try { w.ereignis?.('benachrichtigung', { zeit: eintrag.zeit, stufe: eintrag.stufe, titel: eintrag.titel }); } catch { /* egal */ }
    return eintrag;
  } catch (e) { process.stderr.write(`[benachrichtigungen] ${e && e.message}\n`); return null; }
}

/** Takt Apps: abgestürzte/ungesunde Apps (zweimal hintereinander) melden, Erholung ebenfalls. */
export async function appsPruefen(w) {
  let liste;
  try { const r = await w.intern('apps.liste', {}); liste = Array.isArray(r.ergebnis) ? r.ergebnis : []; } catch { return; }
  for (const a of liste) {
    const problem = appProblem(a);
    const z = appsZustand.get(a.name) || { schlecht: 0, gemeldet: false };
    if (problem) {
      z.schlecht++;
      if (z.schlecht >= 2 && !z.gemeldet) {
        z.gemeldet = true;
        await melden(w, { art: 'apps', stufe: 'fehler', titel: `App „${a.titel || a.name}“ ${problem}`, text: `Die App „${a.titel || a.name}“ ${problem} (Zustand ${a.zustand}${a.gesundheit ? `, ${a.gesundheit}` : ''}). Protokoll und Neustart unter Apps.`, schluessel: `app_${a.name}_${problem}` });
      }
    } else {
      if (z.gemeldet) await melden(w, { art: 'apps', stufe: 'info', titel: `App „${a.titel || a.name}“ läuft wieder`, text: `Die App „${a.titel || a.name}“ läuft wieder normal.`, schluessel: `app_${a.name}_ok_${Date.now()}` });
      z.schlecht = 0; z.gemeldet = false;
    }
    appsZustand.set(a.name, z);
  }
}

/** Takt SMART: Platten mit Warnung/Fehler melden (nur bei Wechsel des Zustands). */
export async function smartPruefen(w) {
  let platten;
  try { const r = await w.intern('system.smart', {}); platten = Array.isArray(r.ergebnis) ? r.ergebnis : []; } catch { return; }
  for (const p of platten) {
    const z = p.zustand;
    const vorher = smartZustand.get(p.geraet);
    smartZustand.set(p.geraet, z);
    if (z === vorher || !['warnung', 'fehler', 'kritisch'].includes(z)) continue;
    await melden(w, {
      art: 'platte', stufe: z === 'warnung' ? 'warnung' : 'fehler', titel: `Platte ${p.modell || p.geraet}: S.M.A.R.T. ${z}`,
      text: `Die Platte ${p.modell || ''} (${p.geraet}) meldet den Zustand „${z}“${p.details && p.details.hinweis ? `: ${p.details.hinweis}` : ''}. Bitte Daten sichern und die Platte prüfen (System → S.M.A.R.T.).`,
      schluessel: `smart_${p.geraet}_${z}`,
    });
  }
}

export function registriere(reg, w) {
  // Persönliche Handy-Meldungen (Plan 02, V9): Test an das eigene Thema und der Server für den QR-Code
  reg.aktion('benachrichtigungen.persoenlich_test', {
    rolle: 'nutzer', schema: {}, beschreibung: 'Testmeldung an das eigene Handy (persönliches ntfy-Thema)',
    ausfuehren: async (_p, k) => ({ gesendet: await persoenlichSenden(w, k.nutzer, { titel: 'FAH-NAS', text: 'Test: Handy-Meldungen funktionieren.', schluessel: `test:${k.nutzer}` }) }),
  });
  reg.aktion('benachrichtigungen.persoenlich_info', {
    rolle: 'nutzer', lesend: true, schema: {}, beschreibung: 'Server der Handy-Meldungen (für den QR-Code, ohne Zugangsdaten)',
    ausfuehren: async () => ({ server: await persoenlichServer(w) }),
  });

  reg.aktion('benachrichtigungen.lesen', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Einstellungen der Benachrichtigungen (ohne Passwörter)',
    ausfuehren: async () => ansicht(await laden(w)),
  });

  const S_OBJ = { typ: 'object' };
  reg.aktion('benachrichtigungen.speichern', {
    rolle: 'admin', beschreibung: 'E-Mail/ntfy und Ereignisse einstellen (leere Passwörter bleiben unverändert)',
    schema: { email: S_OBJ, ntfy: S_OBJ, ereignisse: S_OBJ },
    ausfuehren: async (p) => {
      let neu;
      await w.konfig.aendern(DATEI, (roh) => { neu = eingabePruefen(p, normal(roh)); return neu; }, null);
      w.konfigGeaendert?.('benachrichtigungen');
      return ansicht(neu);
    },
  });

  reg.aktion('benachrichtigungen.test', {
    rolle: 'admin', beschreibung: 'Testnachricht an alle eingeschalteten Kanäle senden',
    schema: {},
    ausfuehren: async () => {
      const c = await laden(w);
      if (!c.email.aktiv && !c.ntfy.aktiv) throw new FahnasFehler('E_PARAMS', 'Es ist weder E-Mail noch ntfy eingeschaltet', { feld: 'email' });
      const e = await melden(w, { art: 'test', stufe: 'info', titel: 'Test – Benachrichtigungen funktionieren', text: 'Diese Testnachricht kommt aus FAH-NAS → System → Benachrichtigungen.' }, { erzwingen: true });
      return e ? e.kanaele : {};
    },
  });

  reg.aktion('benachrichtigungen.verlauf', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Die letzten 50 Benachrichtigungen',
    ausfuehren: async () => { const v = await w.konfig.laden(VERLAUF, []); return Array.isArray(v) ? v : []; },
  });

  reg.aktion('benachrichtigungen.senden', {
    rolle: 'system', beschreibung: 'Meldung von anderen Bereichen (USV, VPN, VMs …) verschicken',
    schema: {
      art: { typ: 'string', pflicht: true, werte: [...ARTEN] }, stufe: { typ: 'string', werte: [...STUFEN], standard: 'info' },
      titel: { typ: 'string', pflicht: true, max: 200 }, text: { typ: 'string', pflicht: true, max: 2000 }, schluessel: { typ: 'string', max: 200 },
    },
    ausfuehren: async (p) => melden(w, p),
  });

  // Anmeldeschutz (Betreiber 16.10.2026): der Web-Dienst meldet Anmeldungen aus dem Internet und Sperren. Er läuft ohne
  // Sitzung (Rolle gast) – deshalb baut der Agent Titel und Text selbst aus geprüften Feldern, und höchstens 30 Meldungen je
  // Stunde gehen hinaus (ein Angriff mit vielen Adressen darf das Handy nicht fluten).
  reg.aktion('benachrichtigungen.anmeldung', {
    rolle: 'gast', beschreibung: 'Anmeldung aus dem Internet oder Sperre einer Adresse melden (vom Web-Dienst)',
    schema: {
      art: { typ: 'string', pflicht: true, werte: ['erfolg', 'sperre'] }, nutzer: { typ: 'string', max: 64, muster: /^[a-z0-9_.-]*$/ },
      ip: { typ: 'string', pflicht: true, max: 45, muster: /^[0-9a-fA-F:.]+$/ }, ort: { typ: 'string', max: 120 }, minuten: { typ: 'integer', min: 0, max: 100_000 },
    },
    ausfuehren: async (p) => {
      const jetzt = Date.now();
      while (anmeldeMeldungen.length && jetzt - anmeldeMeldungen[0] > 3_600_000) anmeldeMeldungen.shift();
      if (anmeldeMeldungen.length >= 30) return null;
      anmeldeMeldungen.push(jetzt);
      // eslint-disable-next-line no-control-regex
      const ort = String(p.ort || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
      const wo = `${p.ip}${ort ? ` (${ort})` : ''}`;
      if (p.art === 'erfolg') {
        return melden(w, { art: 'anmeldung', stufe: 'warnung', titel: `Anmeldung aus dem Internet: ${p.nutzer || '?'}`, text: `${p.nutzer || '?'} hat sich von ${wo} an der FAH-NAS-Oberfläche angemeldet. Warst du das nicht, ändere sofort dein Passwort.` });
      }
      return sperreMelden(w, { ip: p.ip, wo, nutzer: p.nutzer || '', minuten: p.minuten || 0 });
    },
  });
}

function dauerText(minuten) { return minuten >= 60 ? `${Math.round(minuten / 60)} h` : `${minuten || 0} min`; }

/** Sperre melden: sofort, wenn in der letzten Stunde keine Sperr-Meldung hinausging – sonst sammeln (eine Zeile je Adresse). */
export function sperreMelden(w, s, jetzt = Date.now()) {
  const b = sperrBuendel;
  if (!b.timer && jetzt - b.letzte >= b.fenster_ms) {
    b.letzte = jetzt;
    return melden(w, { art: 'anmeldung', stufe: 'info', titel: `Anmeldung gesperrt: ${s.ip}`, text: `${s.wo} wurde nach Fehlversuchen${s.nutzer ? ` (Name „${s.nutzer}“)` : ''} für ${dauerText(s.minuten)} gesperrt. Weitere Sperren in der nächsten Stunde kommen gesammelt.`, schluessel: `anmeldesperre:${s.ip}` });
  }
  const alt = b.offen.find((x) => x.ip === s.ip);
  if (alt) Object.assign(alt, s); else if (b.offen.length < 500) b.offen.push(s);
  if (!b.timer) {
    b.timer = setTimeout(() => { b.timer = null; sammelSenden(w).catch(() => {}); }, Math.max(1000, b.letzte + b.fenster_ms - jetzt));
    b.timer.unref?.();
  }
  return Promise.resolve({ gebuendelt: true, offen: b.offen.length });
}

/** Gesammelte Sperren als EINE Meldung (die ersten 10 Adressen, Rest als Zahl). */
export async function sammelSenden(w, jetzt = Date.now()) {
  const b = sperrBuendel;
  const liste = b.offen.splice(0);
  if (!liste.length) return null;
  b.letzte = jetzt;
  const zeilen = liste.slice(0, SAMMEL_ZEILEN).map((s) => `• ${s.wo}${s.nutzer ? ` – Name „${s.nutzer}“` : ''} – ${dauerText(s.minuten)}`);
  if (liste.length > SAMMEL_ZEILEN) zeilen.push(`… und ${liste.length - SAMMEL_ZEILEN} weitere`);
  return melden(w, { art: 'anmeldung', stufe: 'info', titel: `${liste.length} ${liste.length === 1 ? 'Adresse' : 'Adressen'} gesperrt (letzte Stunde)`, text: `Nach Fehlversuchen bei der Anmeldung aus dem Internet gesperrt:\n${zeilen.join('\n')}` });
}

export async function starten(w) {
  abmelden = w.beobachten?.((e) => {
    if (!e || e.ereignis === 'benachrichtigung') return;
    if (e.ereignis === 'spiegelung' && e.zustand === 'fertig' && e.ergebnis === 'fehler') {
      w.konfig.laden('spiegelung.json', { auftraege: [] }).then((d) => {
        const namen = { spiegelung: Object.fromEntries((d?.auftraege || []).map((a) => [a.id, a.name])) };
        const m = meldungAusEreignis(e, namen); if (m) melden(w, m);
      }).catch(() => {});
      return;
    }
    const m = meldungAusEreignis(e);
    if (m) melden(w, m);
  }) || null;
  appsTimer = setInterval(() => { appsPruefen(w).catch(() => {}); }, APPS_TAKT_MS); appsTimer.unref?.();
  smartErster = setTimeout(() => { smartPruefen(w).catch(() => {}); }, SMART_ERSTER_MS); smartErster.unref?.();
  smartTimer = setInterval(() => { smartPruefen(w).catch(() => {}); }, SMART_TAKT_MS); smartTimer.unref?.();
}

export async function stoppen() {
  if (abmelden) abmelden(); abmelden = null;
  clearTimeout(sperrBuendel.timer); sperrBuendel.timer = null;
  clearInterval(appsTimer); clearInterval(smartTimer); clearTimeout(smartErster);
  appsTimer = null; smartTimer = null; smartErster = null;
}

export const _test = { zuletzt, appsZustand, smartZustand, sperrBuendel };
