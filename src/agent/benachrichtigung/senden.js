// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Benachrichtigungen (Betreiber 12.10.2026) – Versand und Regeln ohne Zustand:
// - E-Mail über curl (smtp/smtps, STARTTLS); Zugangsdaten stehen in einer kurzlebigen 0600-netrc-Datei, nie auf der Befehlszeile.
// - Push über ntfy (JSON an die Server-Wurzel, damit Umlaute im Titel ankommen).
// - Ereignis des Steuerdienstes → Meldung {art, stufe, titel, text, schluessel} (oder null).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';

export const ARTEN = Object.freeze(['platte', 'spiegelung', 'apps', 'updates', 'usv', 'energie', 'vpn', 'vms', 'anmeldung']);
export const STUFEN = Object.freeze(['info', 'warnung', 'fehler']);
const NTFY_PRIO = Object.freeze({ info: 3, warnung: 4, fehler: 5 });
const NTFY_TAG = Object.freeze({ info: 'information_source', warnung: 'warning', fehler: 'rotating_light' });

/** RFC-2047-Betreff (UTF-8, Base64) – Umlaute sicher in der Kopfzeile. */
export function betreffKodieren(text) {
  return `=?UTF-8?B?${Buffer.from(String(text), 'utf8').toString('base64')}?=`;
}

/** Komplette E-Mail (Kopf + Text) für curl --upload-file. */
export function mailText({ von, an, betreff, text, rechner = 'FAH-NAS', jetzt = new Date() }) {
  const id = `${crypto.randomBytes(8).toString('hex')}@${String(rechner).replace(/[^A-Za-z0-9.-]/g, '') || 'fahnas'}`;
  return [
    `From: FAH-NAS <${von}>`, `To: ${an.join(', ')}`, `Subject: ${betreffKodieren(betreff)}`, `Date: ${jetzt.toUTCString()}`,
    `Message-ID: <${id}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '',
    String(text).replace(/\r?\n/g, '\r\n'), '',
  ].join('\r\n');
}

/** curl-Argumente für den Mailversand (ohne Passwort – das steht in der netrc-Datei). */
export function curlMailArgumente(e, netrc) {
  const tls = e.sicherheit === 'tls';
  const url = `${tls ? 'smtps' : 'smtp'}://${e.server}:${e.port || (tls ? 465 : 587)}`;
  const a = ['--silent', '--show-error', '--max-time', '30', '--url', url, '--mail-from', e.absender];
  for (const r of e.empfaenger) a.push('--mail-rcpt', r);
  if (e.sicherheit === 'starttls') a.push('--ssl-reqd');
  if (e.benutzer) a.push('--netrc-file', netrc);
  a.push('--upload-file', '-');
  return a;
}

/** netrc-Zeile mit Anführungszeichen (curl ≥ 7.84): Passwörter mit Leerzeichen, # oder " gehen sonst kaputt (Test-Fund 12.10.). */
export function netrcZeile(server, benutzer, passwort) {
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `machine ${server} login ${q(benutzer)} password ${q(passwort)}\n`;
}

/** E-Mail senden. Wirft E_SYSTEM mit der Meldung von curl. */
export async function emailSenden(system, e, { betreff, text, rechner }) {
  if (!e || !e.server || !e.absender || !Array.isArray(e.empfaenger) || !e.empfaenger.length) throw new FahnasFehler('E_PARAMS', 'E-Mail: Server, Absender und Empfänger fehlen', { feld: 'email' });
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahnas-mail-'));
  const netrc = path.join(ordner, 'netrc');
  try {
    if (e.benutzer) await fs.writeFile(netrc, netrcZeile(e.server, e.benutzer, e.passwort || ''), { mode: 0o600 });
    await system.ausfuehren('curl', curlMailArgumente(e, netrc), { eingabe: mailText({ von: e.absender, an: e.empfaenger, betreff, text, rechner }), zeitlimit_ms: 45_000 });
  } catch (f) {
    const x = FahnasFehler.aus(f);
    throw new FahnasFehler('E_SYSTEM', `E-Mail konnte nicht gesendet werden: ${String((x.details && x.details.ausgabe) || x.message).trim().split('\n').pop().slice(0, 200)}`);
  } finally { await fs.rm(ordner, { recursive: true, force: true }); }
}

/** ntfy-Nachricht (JSON-Form). */
export function ntfyNachricht(n, { titel, text, stufe, klick }) {
  return {
    topic: n.thema, title: titel, message: text, priority: NTFY_PRIO[stufe] || 3, tags: [NTFY_TAG[stufe] || 'bell', 'fah-nas'],
    ...(typeof klick === 'string' && /^https?:\/\//i.test(klick) ? { click: klick } : {}), // Antippen öffnet z. B. den Chat-Raum
  };
}

/** Push über ntfy senden. `holen` = fetch (für Tests ersetzbar). */
export async function ntfySenden(n, meldung, holen = fetch) {
  if (!n || !n.server || !n.thema) throw new FahnasFehler('E_PARAMS', 'ntfy: Server und Thema fehlen', { feld: 'ntfy' });
  const kopf = { 'Content-Type': 'application/json' };
  if (n.token) kopf.Authorization = `Bearer ${n.token}`;
  else if (n.benutzer) kopf.Authorization = `Basic ${Buffer.from(`${n.benutzer}:${n.passwort || ''}`).toString('base64')}`;
  let r;
  try {
    r = await holen(String(n.server).replace(/\/+$/, ''), { method: 'POST', headers: kopf, body: JSON.stringify(ntfyNachricht(n, meldung)), signal: AbortSignal.timeout(15_000) });
  } catch (e) { throw new FahnasFehler('E_SYSTEM', `ntfy nicht erreichbar: ${e.message}`); }
  if (!r.ok) throw new FahnasFehler('E_SYSTEM', `ntfy lehnte ab (HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' – Zugang prüfen' : ''})`);
}

/**
 * Ereignis des Steuerdienstes → Meldung. Gibt null zurück, wenn das Ereignis keine Benachrichtigung auslöst.
 * `namen` = Hilfe zum Auflösen von Kennungen (z. B. Spiegelungsname).
 */
export function meldungAusEreignis(e, namen = {}) {
  if (!e || typeof e !== 'object') return null;
  if (e.ereignis === 'system') {
    const d = e.daten || {};
    if (e.art === 'platte_voll') return { art: 'platte', stufe: 'warnung', titel: 'Datenplatte fast voll', text: `Die Datenpartition ist zu ${Math.round(d.prozent ?? 0)} % belegt. Ab 95 % stoppen Schnappschüsse – bitte aufräumen oder alte Schnappschüsse löschen.`, schluessel: 'platte_voll' };
    if (e.art === 'update_fertig' && d.neustart_noetig) return { art: 'updates', stufe: 'info', titel: 'Neustart nötig', text: `${d.anzahl ?? 'Einige'} System-Updates wurden eingespielt. Für einige davon ist ein Neustart des NAS nötig.`, schluessel: 'update_neustart' };
    if (e.art === 'programm_update') return { art: 'updates', stufe: 'info', titel: 'FAH-NAS aktualisiert', text: `FAH-NAS wurde von ${d.von || '?'} auf ${d.nach || '?'} aktualisiert.`, schluessel: `programm_${d.nach}` };
    return null;
  }
  if (e.ereignis === 'spiegelung' && e.zustand === 'fertig' && e.ergebnis === 'fehler') {
    const name = namen.spiegelung?.[e.id] || e.id;
    return { art: 'spiegelung', stufe: 'fehler', titel: `Spiegelung „${name}“ fehlgeschlagen`, text: e.meldung || 'Der Abgleich ist fehlgeschlagen – Details im Protokoll der Spiegelung.', schluessel: `spiegelung_${e.id}` };
  }
  return null;
}

/** Zustand einer App, der eine Warnung wert ist (abgestürzt, hängt im Neustart, ungesund) – nicht bei Stopp von Hand. */
export function appProblem(a) {
  if (!a || !a.autostart || a.von_hand_gestoppt) return null;
  const g = String(a.gesundheit || '').toLowerCase();
  if (a.zustand === 'restarting') return 'startet ständig neu';
  if (a.zustand === 'dead') return 'ist abgestürzt';
  if (a.zustand === 'exited' || a.zustand === 'teilweise') return a.zustand === 'teilweise' ? 'läuft nur teilweise' : 'läuft nicht mehr';
  if (g === 'unhealthy') return 'meldet sich als ungesund';
  return null;
}
