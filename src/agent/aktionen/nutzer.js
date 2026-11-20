// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Aktionen „nutzer.*“: users.json ist die Wahrheit (Nutzer, Rollen, Gruppen, scrypt-Hash, TOTP). Daraus werden
// Linux-Konten (Gruppen fahnas-nutzer/fahnas-admin) und Samba-Passwörter gerendert. nutzer.apply (Rolle system)
// baut alles idempotent wieder auf – z. B. nach einer Neuinstallation mit übernommener Datenpartition.
// Alles, was users.json liest UND zurückschreibt, läuft über konfig.aendern (Lesen-Ändern-Schreiben unter der
// Sperre der Datei) – sonst könnte ein gleichzeitiger Login (letzte_anmeldung) einen frisch angelegten Nutzer
// wieder aus der Datei löschen.
// Seit 0.22.0 hat jeder Nutzer auf Wunsch einen Avatar (Betreiber 19.10.2026: „avatar/bild … was dann als userbild überall
// angezeigt wird“): Datei config/avatare/<name>, in users.json nur {v, mime}; nutzer.avatare liefert allen Angemeldeten die
// Versionen, damit jede Oberfläche Bild oder Anfangsbuchstaben zeigen kann.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { R } from '../../gemeinsam/schema.js';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { PFADE } from '../../gemeinsam/pfade.js';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import * as totp from '../totp.js';
import * as ln from '../render/linuxnutzer.js';
import { nutzerAusFreigabenEntfernen, gruppeAusFreigabenEntfernen, nutzerInFreigabenUmbenennen } from './freigaben.js';
import { nutzerAusAppsEntfernen, gruppeAusAppsEntfernen, nutzerInAppsUmbenennen } from './apps.js';
import { heimExklusiv, heimBelegt, heimUmbenennen } from './heim.js';
import { linksNutzerUmbenennen } from './dateien.js';
import { protokolleNutzerUmbenennen } from './protokolle.js';
import { nutzerAusChatEntfernen, nutzerImChatUmbenennen } from '../chat/konten.js';
import { officeKontoEntfernen, officeKontoUmbenennen } from '../office/index.js';
import { faelligVergessen } from '../office/faellig.js';
import { umbenennungMerken, umbenennungVergessen } from '../helfer/umbenennungen.js';

const DATEI = 'users.json';
const MODUS = 0o600; // Hashes und TOTP-Geheimnisse: nur root liest
// Namen, die nie NAS-Nutzer oder -Gruppen werden dürfen (zusätzlich gilt: Systemkonten mit uid < 1000 nie anfassen)
export const RESERVIERT = new Set(['root', 'nobody', 'nogroup', 'fahnas', 'konsole', 'web', 'gast', 'system', ln.GRUPPE_NUTZER, ln.GRUPPE_ADMIN, 'daemon', 'bin', 'sys', 'sync', 'games',
  'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'sshd', 'messagebus', 'systemd-network',
  'systemd-resolve', 'systemd-timesync', 'sudo', 'adm', 'users', 'docker', 'libvirt', 'kvm', 'staff', 'wheel', 'shadow', 'tty', 'disk',
  'constructor']); // „constructor“: einziger kleingeschriebener Name auf Object.prototype – Schlüssel-Abfragen fielen sonst darauf herein

/** Avatar: höchstens so groß (Bytes); die Oberfläche schickt 256 × 256 px, meist unter 50 KB. */
export const AVATAR_MAX = 300 * 1024;
const MUSTER_GRUPPE = /^[a-z][a-z0-9_-]{1,30}$/;
// eslint-disable-next-line no-control-regex
const MUSTER_TEXT = /^[^\r\n\u0000-\u001f\u007f]*$/;
// eslint-disable-next-line no-control-regex
const MUSTER_PASSWORT = /^[^\r\n\u0000-\u001f]+$/;

const S = Object.freeze({
  gruppenname: { typ: 'string', pflicht: true, muster: MUSTER_GRUPPE, hinweis: 'Gruppenname: klein, beginnt mit Buchstabe, 2–31 Zeichen aus a-z, 0-9, - und _' },
  gruppen: { typ: 'array', max: 100, elemente: { typ: 'string', max: 32, muster: MUSTER_GRUPPE, hinweis: 'Gruppenname ungültig' } },
  rolle: { typ: 'string', werte: ['admin', 'nutzer'] },
  anzeigename: { typ: 'string', max: 100, muster: MUSTER_TEXT, hinweis: 'Anzeigename darf keine Steuerzeichen enthalten' },
  passwort: { ...R.passwort, muster: MUSTER_PASSWORT, hinweis: 'Passwort darf keine Zeilenumbrüche oder Steuerzeichen enthalten' },
  passwortFrei: { typ: 'string', pflicht: true, max: 256 },
  passwortOptional: { typ: 'string', max: 256 },
  code: { typ: 'string', pflicht: true, min: 6, max: 24, muster: /^[A-Za-z0-9 -]+$/, hinweis: 'Code darf nur Buchstaben und Ziffern enthalten' },
  avatar: { typ: 'string', pflicht: true, min: 4, max: Math.ceil(AVATAR_MAX / 3) * 4 + 1024, muster: /^[A-Za-z0-9+/]+={0,2}$/, hinweis: 'Bild ungültig' },
});

// --- Konfiguration ---------------------------------------------------------

function normieren(d) {
  return { ...(d && typeof d === 'object' ? d : {}), nutzer: Array.isArray(d?.nutzer) ? d.nutzer : [], gruppen: Array.isArray(d?.gruppen) ? d.gruppen : [] };
}

async function laden(konfig) { return normieren(await konfig.laden(DATEI)); }

/**
 * Lesen-Ändern-Schreiben unter der Sperre von users.json. `fn(daten, merk)` darf Systembefehle ausführen und
 * werfen – dann wird nichts geschrieben; `merk.unveraendert = true` verhindert das Schreiben ebenfalls.
 * Rückgabewert von fn ist das Ergebnis der Aktion.
 */
async function aendern(konfig, fn) {
  let ergebnis;
  await konfig.aendern(DATEI, async (roh) => {
    const daten = normieren(roh);
    const merk = { unveraendert: false };
    ergebnis = await fn(daten, merk);
    return merk.unveraendert ? UNVERAENDERT : daten;
  }, undefined, MODUS);
  return ergebnis;
}

function finde(daten, name) { return daten.nutzer.find((n) => n.name === name) || null; }

// --- Avatare -------------------------------------------------------------------

/** Bildart aus den ersten Bytes (nie aus Name oder Angabe des Browsers): nur PNG, JPEG, WebP – kein SVG (Skript im Bild). */
export function avatarArt(b) {
  if (b.length >= 8 && b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const avatarPfad = (konfig, name) => path.join(konfig.ordner, 'avatare', name);

/** Avatar-Datei ersetzen: erst eine Zwischendatei, dann umbenennen – nie ein halbes Bild. */
async function avatarSchreiben(konfig, name, bild) {
  const ziel = avatarPfad(konfig, name);
  await fs.mkdir(path.dirname(ziel), { recursive: true, mode: 0o750 });
  const zwischen = `${ziel}.${crypto.randomBytes(4).toString('hex')}.neu`;
  await fs.writeFile(zwischen, bild, { mode: 0o640 });
  try { await fs.rename(zwischen, ziel); } catch (e) { await fs.rm(zwischen, { force: true }); throw e; }
}
const avatarWeg = (konfig, name) => fs.rm(avatarPfad(konfig, name), { force: true });

function admins(daten) { return daten.nutzer.filter((n) => n.rolle === 'admin'); }
function aktiveAdmins(daten) { return admins(daten).filter((n) => !n.gesperrt); }

/** Öffentliche Sicht ohne Hash und Geheimnisse. */
function oeffentlich(n) {
  return {
    name: n.name, anzeigename: n.anzeigename || '', rolle: n.rolle, uid: n.uid ?? null, gruppen: n.gruppen || [],
    totp: !!n.totp, gesperrt: !!n.gesperrt, erstellt: n.erstellt || null, letzte_anmeldung: n.letzte_anmeldung || null,
    avatar: n.avatar && n.avatar.v ? n.avatar.v : null,
  };
}

function istAdmin(kontext) { return kontext.rolle === 'admin' || kontext.rolle === 'system'; }

/** Rolle system (intern) und die Kennung „konsole“ (Kommandozeile als root) brauchen für 2FA-Eingriffe kein Passwort – Notfallweg. */
function ohnePasswort(kontext) { return kontext.rolle === 'system' || kontext.nutzer === 'konsole'; }

/** Nutzer dürfen nur sich selbst bearbeiten; Admins alle. */
function nurSelbst(kontext, name) {
  if (!istAdmin(kontext) && kontext.nutzer !== name) throw new FahnasFehler('E_RECHTE', 'Das darfst du nur für dein eigenes Konto');
}

/** Prüft das Passwort des Handelnden (kontext.nutzer) – für 2FA einrichten/entfernen. */
async function handelndenPruefen(daten, kontext, passwort) {
  if (ohnePasswort(kontext)) return;
  if (typeof passwort !== 'string' || !passwort) throw new FahnasFehler('E_PARAMS', 'Bitte bestätige mit deinem Passwort', { feld: 'passwort' });
  const handelnd = finde(daten, kontext.nutzer);
  if (!handelnd || !(await totp.hashPruefen(passwort.normalize('NFC'), handelnd.hash))) throw new FahnasFehler('E_ANMELDUNG', 'Das Passwort ist falsch', { feld: 'passwort' });
}

function gruppenPruefen(daten, gruppen) {
  for (const g of gruppen) if (!daten.gruppen.some((x) => x.name === g)) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Gruppe „${g}“ gibt es nicht`, { feld: 'gruppen', wert: g });
  return [...new Set(gruppen)];
}

/** Linux-Gruppen, die ein Nutzer laut Konfiguration haben soll. */
// Gesperrte Admins verlieren fahnas-admin (und damit sudo/root, adminroot.js), bis sie entsperrt sind
function sollGruppen(n) { return [ln.GRUPPE_NUTZER, ...(istAktiverAdmin(n) ? [ln.GRUPPE_ADMIN] : []), ...(n.gruppen || [])]; }
function istAktiverAdmin(n) { return n.rolle === 'admin' && !n.gesperrt; }
/** Gruppen, deren Mitgliedschaft wir verwalten (nur diese werden auch entzogen). */
function verwaltet(daten) { return new Set([ln.GRUPPE_ADMIN, ...daten.gruppen.map((g) => g.name)]); }

async function hostname(konfig) {
  try { const s = await konfig.laden('system.json'); return (s && s.hostname) || 'fahnas'; } catch { return 'fahnas'; }
}

// --- Registrierung -----------------------------------------------------------

export function registriere(reg, werkzeuge) {
  const { konfig, system } = werkzeuge;
  const geaendert = () => werkzeuge.konfigGeaendert?.('nutzer');
  // Ordnerrechte hängen an Gruppen und Rolle (Gruppenregeln werden je Mitglied auf die Platte geschrieben) → nachziehen
  const ordnerrechteNachziehen = () => {
    try { Promise.resolve(werkzeuge.intern?.('freigaben.ordnerrechte.apply', {})).catch((e) => process.stderr.write(`[nutzer] Ordnerrechte: ${e && e.message}\n`)); } catch { /* Bereich fehlt (Test) */ }
  };

  reg.aktion('nutzer.liste', {
    rolle: 'admin', schema: {}, beschreibung: 'Alle Nutzer (ohne Hashes)',
    ausfuehren: async () => (await laden(konfig)).nutzer.map(oeffentlich),
  });

  reg.aktion('nutzer.anlegen', {
    rolle: 'admin', beschreibung: 'Nutzer anlegen: Linux-Konto ohne Anmeldeshell, Samba-Passwort, Web-Hash',
    schema: { name: R.nutzername, anzeigename: { ...S.anzeigename, standard: '' }, passwort: S.passwort, rolle: { ...S.rolle, pflicht: true }, gruppen: { ...S.gruppen, standard: [] } },
    ausfuehren: async (p) => {
      if (RESERVIERT.has(p.name)) throw new FahnasFehler('E_PARAMS', `„${p.name}“ ist ein reservierter Name`, { feld: 'name' });
      const ergebnis = await aendern(konfig, async (daten) => {
        if (finde(daten, p.name)) throw new FahnasFehler('E_EXISTIERT', `Nutzer „${p.name}“ gibt es schon`, { feld: 'name' });
        if (daten.gruppen.some((g) => g.name === p.name)) throw new FahnasFehler('E_EXISTIERT', `„${p.name}“ ist schon der Name einer Gruppe`, { feld: 'name' });
        const gruppen = gruppenPruefen(daten, p.gruppen);

        let konto = await ln.linuxNutzer(system, p.name);
        if (konto && konto.uid < ln.ERSTE_NUTZER_UID) throw new FahnasFehler('E_EXISTIERT', `„${p.name}“ ist ein Systemkonto und kann kein NAS-Nutzer werden`, { feld: 'name' });

        await ln.gruppeSicherstellen(system, ln.GRUPPE_NUTZER, true);
        await ln.gruppeSicherstellen(system, ln.GRUPPE_ADMIN, true);
        for (const g of gruppen) await ln.gruppeSicherstellen(system, g);

        const n = { name: p.name, anzeigename: p.anzeigename, rolle: p.rolle, uid: null, gruppen, hash: null, totp: null, gesperrt: false, erstellt: new Date().toISOString(), letzte_anmeldung: null };
        umbenennungVergessen(daten, p.name); // Office-Inhalte mit diesem Namen gehören ab jetzt dem neuen Nutzer
        let uebernommen = false;
        if (konto) {
          // vorhandenes Linux-Konto (z. B. der Installer-Benutzer) wird übernommen: Gruppen ergänzen, Passwort neu setzen
          uebernommen = true;
          await ln.gruppenAngleichen(system, p.name, sollGruppen(n), verwaltet(daten));
        } else {
          await ln.nutzerAnlegen(system, { name: p.name, gruppen: sollGruppen(n) });
          konto = await ln.linuxNutzer(system, p.name);
        }
        await ln.shellAngleichen(system, p.name, istAktiverAdmin(n));
        n.uid = konto ? konto.uid : null;
        const passwort = p.passwort.normalize('NFC');
        await ln.passwortSetzen(system, p.name, passwort);
        n.hash = await totp.hashErzeugen(passwort);
        daten.nutzer.push(n);
        return { ...oeffentlich(n), uebernommen };
      });
      geaendert();
      ordnerrechteNachziehen();
      return ergebnis;
    },
  });

  reg.aktion('nutzer.aendern', {
    rolle: 'admin', beschreibung: 'Anzeigename, Rolle, Gruppen oder Sperre ändern',
    schema: { name: R.nutzername, anzeigename: S.anzeigename, rolle: S.rolle, gruppen: S.gruppen, gesperrt: { typ: 'boolean' } },
    ausfuehren: async (p, kontext) => {
      const ergebnis = await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        const neu = { ...n };
        if (p.anzeigename !== undefined) neu.anzeigename = p.anzeigename;
        if (p.gruppen !== undefined) neu.gruppen = gruppenPruefen(daten, p.gruppen);
        if (p.rolle !== undefined && p.rolle !== n.rolle) {
          if (n.rolle === 'admin' && !n.gesperrt && aktiveAdmins(daten).length <= 1) throw new FahnasFehler('E_PARAMS', 'Der letzte Admin kann nicht zum Nutzer herabgestuft werden', { feld: 'rolle' });
          neu.rolle = p.rolle;
        }
        if (p.gesperrt !== undefined && p.gesperrt !== !!n.gesperrt) {
          if (p.gesperrt && kontext.nutzer === p.name) throw new FahnasFehler('E_PARAMS', 'Du kannst dich nicht selbst sperren', { feld: 'gesperrt' });
          if (p.gesperrt && n.rolle === 'admin' && aktiveAdmins(daten).length <= 1) throw new FahnasFehler('E_PARAMS', 'Der letzte aktive Admin kann nicht gesperrt werden', { feld: 'gesperrt' });
          neu.gesperrt = p.gesperrt;
        }
        // ins System
        const gruppenAnders = neu.rolle !== n.rolle || !!neu.gesperrt !== !!n.gesperrt || JSON.stringify(neu.gruppen || []) !== JSON.stringify(n.gruppen || []);
        if (gruppenAnders) {
          for (const g of neu.gruppen || []) await ln.gruppeSicherstellen(system, g);
          await ln.gruppenAngleichen(system, p.name, sollGruppen(neu), verwaltet(daten));
          await ln.shellAngleichen(system, p.name, istAktiverAdmin(neu));
        }
        if (!!neu.gesperrt !== !!n.gesperrt) { if (neu.gesperrt) await ln.sperren(system, p.name); else await ln.entsperren(system, p.name); }
        Object.assign(n, neu);
        return oeffentlich(n);
      });
      geaendert();
      ordnerrechteNachziehen();
      return ergebnis;
    },
  });

  // Betreiber 20.10.2026: „ich kann usernamen nicht nachträglich ändern“. Reihenfolge: erst Linux/Samba (der Rest sucht
  // Konten per Namen), dann persönlicher Ordner – beides unter der Sperre von users.json und nacheinander mit heim.apply,
  // sonst hielte es den Ordner für verwaist –, dann alles, was den Namen speichert. Sitzungen beendet der Web-Dienst.
  reg.aktion('nutzer.umbenennen', {
    rolle: 'admin', beschreibung: 'Nutzer umbenennen: Linux/Samba (Passwort bleibt), persönlicher Ordner, Rechte, Apps, Chat, Office, Links',
    schema: { name: R.nutzername, neu: R.nutzername },
    ausfuehren: async (p) => {
      if (p.neu === p.name) throw new FahnasFehler('E_PARAMS', 'Der neue Name ist derselbe wie der alte', { feld: 'neu' });
      if (RESERVIERT.has(p.neu)) throw new FahnasFehler('E_PARAMS', `„${p.neu}“ ist ein reservierter Name`, { feld: 'neu' });
      const shares = await konfig.laden('shares.json', null).catch(() => null);
      if (((shares && shares.freigaben) || []).some((f) => f && f.name === p.neu)) throw new FahnasFehler('E_EXISTIERT', `„${p.neu}“ ist schon der Name einer Freigabe`, { feld: 'neu' });
      let ergebnis = null;
      await heimExklusiv(() => aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        if (finde(daten, p.neu)) throw new FahnasFehler('E_EXISTIERT', `Nutzer „${p.neu}“ gibt es schon`, { feld: 'neu' });
        if (daten.gruppen.some((g) => g.name === p.neu)) throw new FahnasFehler('E_EXISTIERT', `„${p.neu}“ ist schon der Name einer Gruppe`, { feld: 'neu' });
        if (await heimBelegt(werkzeuge, p.neu)) throw new FahnasFehler('E_EXISTIERT', `Unter „${p.neu}“ liegt schon ein persönlicher Ordner (z. B. eines früher gelöschten Nutzers)`, { feld: 'neu' });
        await ln.nutzerUmbenennen(system, p.name, p.neu);
        try { await heimUmbenennen(werkzeuge, n, p.neu); } catch (e) {
          try { await ln.nutzerUmbenennen(system, p.neu, p.name); } catch (f) { process.stderr.write(`[nutzer] Umbenennen zurück ${p.neu} → ${p.name}: ${f.message}\n`); }
          throw e;
        }
        const tausch = (x) => (x === p.name ? p.neu : x);
        n.name = p.neu;
        for (const g of daten.gruppen) if (Array.isArray(g.mitglieder) && g.mitglieder.includes(p.name)) g.mitglieder = g.mitglieder.map(tausch);
        // „Verstanden“ im Handlungsbedarf hängt an Kennungen wie 2fa-<name>, pw-<name>, heim-<name>
        for (const x of daten.nutzer) {
          const q = x.einstellungen && x.einstellungen.handlungsbedarf && x.einstellungen.handlungsbedarf.quittiert;
          if (q && typeof q === 'object') x.einstellungen.handlungsbedarf.quittiert = Object.fromEntries(Object.entries(q).map(([k, v]) => [k.replace(/^(2fa|pw|heim)-(.+)$/, (m, a, b) => (b === p.name ? `${a}-${p.neu}` : m)), v]));
        }
        umbenennungMerken(daten, p.name, p.neu);
        ergebnis = oeffentlich(n);
      }));
      try { await fs.rename(avatarPfad(konfig, p.name), avatarPfad(konfig, p.neu)); } catch (e) { if (e.code !== 'ENOENT') process.stderr.write(`[nutzer] Avatar ${p.name}: ${e.message}\n`); }
      const schritt = async (was, fn) => { try { return await fn(); } catch (e) { process.stderr.write(`[nutzer] Umbenennen ${p.name} → ${p.neu}, ${was}: ${e.message}\n`); return null; } };
      await schritt('Freigaben', () => nutzerInFreigabenUmbenennen(werkzeuge, p.name, p.neu));
      await schritt('Protokolle', () => protokolleNutzerUmbenennen(werkzeuge, p.name, p.neu));
      await schritt('Apps', () => nutzerInAppsUmbenennen(werkzeuge, p.name, p.neu));
      await schritt('Freigabelinks', () => linksNutzerUmbenennen(werkzeuge, p.name, p.neu));
      await schritt('Office', () => officeKontoUmbenennen(werkzeuge, p.name, p.neu));
      faelligVergessen();
      const chat = await schritt('Chat', () => nutzerImChatUmbenennen(werkzeuge, p.name, p.neu));
      const umzug = (chat && chat.umzug) || {};
      if (Object.keys(umzug).length) {
        // stumm geschaltete DMs (beide Seiten) folgen der neuen Kennung
        await schritt('Stumm-Listen', () => aendern(konfig, async (daten, merk) => {
          let anders = false;
          for (const x of daten.nutzer) {
            const s = x.einstellungen && x.einstellungen.chat && x.einstellungen.chat.stumm;
            if (Array.isArray(s) && s.some((id) => Object.hasOwn(umzug, id))) { x.einstellungen.chat.stumm = s.map((id) => (Object.hasOwn(umzug, id) ? umzug[id] : id)); anders = true; }
          }
          if (!anders) merk.unveraendert = true;
        }));
      }
      await schritt('persönlicher Ordner', () => werkzeuge.intern('heim.apply', {}));
      await schritt('Samba', () => werkzeuge.intern('freigaben.apply', {})); // [homes] und Rechte neu
      geaendert();
      ordnerrechteNachziehen();
      return { ...ergebnis, alt: p.name };
    },
  });

  reg.aktion('nutzer.passwort', {
    rolle: 'nutzer', beschreibung: 'Passwort setzen (eigenes mit altem Passwort; Admin für alle)',
    schema: { name: R.nutzername, passwort: S.passwort, altes_passwort: { typ: 'string', max: 256 } },
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        if (!istAdmin(kontext)) {
          if (!p.altes_passwort) throw new FahnasFehler('E_PARAMS', 'Bitte gib dein altes Passwort mit an', { feld: 'altes_passwort' });
          if (!(await totp.hashPruefen(p.altes_passwort.normalize('NFC'), n.hash))) throw new FahnasFehler('E_ANMELDUNG', 'Das alte Passwort ist falsch', { feld: 'altes_passwort' });
        }
        const passwort = p.passwort.normalize('NFC');
        await ln.passwortSetzen(system, p.name, passwort);
        n.hash = await totp.hashErzeugen(passwort);
      });
      geaendert();
      return { name: p.name };
    },
  });

  reg.aktion('nutzer.loeschen', {
    rolle: 'admin', beschreibung: 'Nutzer löschen; Dateien behalten oder mitlöschen',
    schema: { name: R.nutzername, dateien: { typ: 'string', pflicht: true, werte: ['behalten', 'loeschen'] } },
    ausfuehren: async (p, kontext) => {
      let anzeige = p.name;
      await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        if (kontext.nutzer === p.name && kontext.rolle !== 'system') throw new FahnasFehler('E_PARAMS', 'Du kannst dich nicht selbst löschen', { feld: 'name' });
        anzeige = n.anzeigename || n.name;
        if (n.rolle === 'admin' && (admins(daten).length <= 1 || (!n.gesperrt && aktiveAdmins(daten).length <= 1))) {
          throw new FahnasFehler('E_PARAMS', 'Der letzte Admin kann nicht gelöscht werden', { feld: 'name' });
        }
        const pf = werkzeuge.pfade || PFADE;
        if (p.dateien === 'loeschen') await ln.dateienLoeschen(system, pf.shares || PFADE.shares, { name: n.name, uid: n.uid });
        await ln.nutzerLoeschen(system, p.name);
        daten.nutzer = daten.nutzer.filter((x) => x.name !== p.name);
      });
      await avatarWeg(konfig, p.name); // ein neuer gleichnamiger Nutzer erbt kein Bild
      // erst nach dem Schreiben: die Freigaben lesen users.json ohne den Gelöschten und rendern ACLs neu
      await nutzerAusFreigabenEntfernen(werkzeuge, p.name);
      // Plan 07: ein neuer gleichnamiger Nutzer erbt keine Apps
      try { await nutzerAusAppsEntfernen(werkzeuge, p.name); } catch (e) { process.stderr.write(`[nutzer] Apps bereinigen: ${e.message}\n`); }
      // Prüfbericht Plan 02, Befund 5: … und auch keine Chat-Räume oder Direktnachrichten
      await nutzerAusChatEntfernen(werkzeuge, p.name, anzeige);
      // Prüfbericht Plan 04, I2: … und keine Office-Freigaben, kein „Zuletzt“, keinen Besitz an Office-Dokumenten
      await officeKontoEntfernen(werkzeuge, p.name);
      try { await werkzeuge.intern('heim.apply', {}); } catch { /* Bereich fehlt (Test) */ } // persönlichen Ordner aufbewahren
      geaendert();
      return { name: p.name, dateien: p.dateien };
    },
  });

  reg.aktion('nutzer.avatare', {
    rolle: 'nutzer', schema: {}, beschreibung: 'Avatar-Versionen aller Nutzer {name: v} – damit jede Oberfläche Bild oder Anfangsbuchstaben zeigt',
    ausfuehren: async () => Object.fromEntries((await laden(konfig)).nutzer.filter((n) => n.avatar && n.avatar.v).map((n) => [n.name, n.avatar.v])),
  });

  reg.aktion('nutzer.avatar.lesen', {
    rolle: 'nutzer', schema: { name: R.nutzername }, beschreibung: 'Avatar eines Nutzers {mime, v, daten (base64)}',
    ausfuehren: async (p) => {
      const n = finde(await laden(konfig), p.name);
      let bild = null;
      if (n && n.avatar && n.avatar.v) { try { bild = await fs.readFile(avatarPfad(konfig, p.name)); } catch { /* Datei fehlt */ } }
      if (!bild) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Für diesen Nutzer ist kein Bild hinterlegt', { feld: 'name' });
      return { mime: n.avatar.mime, v: n.avatar.v, daten: bild.toString('base64') };
    },
  });

  reg.aktion('nutzer.avatar.setzen', {
    rolle: 'nutzer', schema: { name: R.nutzername, daten: S.avatar }, beschreibung: 'Avatar setzen (PNG/JPEG/WebP bis 300 KB, base64) – das eigene; Admins jedes',
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      const bild = Buffer.from(p.daten, 'base64');
      if (!bild.length || bild.length > AVATAR_MAX) throw new FahnasFehler('E_PARAMS', `Das Bild darf höchstens ${AVATAR_MAX / 1024} KB groß sein`, { feld: 'daten' });
      const mime = avatarArt(bild);
      if (!mime) throw new FahnasFehler('E_PARAMS', 'Bitte ein Bild im Format PNG, JPEG oder WebP wählen', { feld: 'daten' });
      const v = crypto.createHash('sha256').update(bild).digest('hex').slice(0, 12);
      await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        await avatarSchreiben(konfig, p.name, bild);
        n.avatar = { v, mime };
      });
      geaendert();
      return { v };
    },
  });

  reg.aktion('nutzer.avatar.loeschen', {
    rolle: 'nutzer', schema: { name: R.nutzername }, beschreibung: 'Avatar entfernen (das eigene; Admins jedes) – danach wieder Anfangsbuchstaben',
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      await aendern(konfig, async (daten, merk) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        if (!n.avatar) { merk.unveraendert = true; return; }
        delete n.avatar;
      });
      await avatarWeg(konfig, p.name);
      geaendert();
      return { name: p.name };
    },
  });

  reg.aktion('nutzer.pruefen', {
    rolle: 'gast', beschreibung: 'Anmeldung prüfen (Web-Login); dauert für unbekannte Nutzer genauso lange',
    schema: { name: { typ: 'string', pflicht: true, max: 64 }, passwort: S.passwortFrei },
    ausfuehren: async (p) => {
      const daten = await laden(konfig);
      const n = finde(daten, p.name);
      const hash = n && n.hash ? n.hash : await totp.scheinHash();
      const ok = await totp.hashPruefen(p.passwort.normalize('NFC'), hash);
      if (!n || !ok || n.gesperrt) return { ok: false };
      const totpNoetig = !!n.totp;
      if (!totpNoetig) {
        // letzte_anmeldung unter der Sperre der Datei – nie einen gleichzeitig angelegten Nutzer überschreiben
        await aendern(konfig, (d) => { const x = finde(d, p.name); if (x) x.letzte_anmeldung = new Date().toISOString(); });
      }
      return { ok: true, rolle: n.rolle, totp_noetig: totpNoetig, anzeigename: n.anzeigename || n.name, totp: totpNoetig };
    },
  });

  reg.aktion('nutzer.totp.einrichten', {
    rolle: 'nutzer', beschreibung: 'Zwei-Faktor-Anmeldung vorbereiten (mit eigenem Passwort bestätigen): Geheimnis und otpauth-URI',
    schema: { name: R.nutzername, passwort: S.passwortOptional },
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      const geheimnis = totp.geheimnisErzeugen();
      await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        // Auch bei bereits aktiver 2FA: eine gestohlene Sitzung darf Geheimnis und Wiederherstellungscodes nicht tauschen
        await handelndenPruefen(daten, kontext, p.passwort);
        n.totp_ausstehend = { geheimnis, erstellt: new Date().toISOString() };
      });
      const uri = totp.otpauthUri({ geheimnis, konto: `${p.name}@${await hostname(konfig)}` });
      return { geheimnis, uri };
    },
  });

  reg.aktion('nutzer.totp.bestaetigen', {
    rolle: 'nutzer', beschreibung: 'Zwei-Faktor-Anmeldung mit erstem Code scharf schalten; liefert Wiederherstellungscodes',
    schema: { name: R.nutzername, code: S.code },
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      const codes = totp.wiederherstellungscodesErzeugen();
      const hashes = await totp.wiederherstellungscodesHashen(codes);
      await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        if (!n.totp_ausstehend) throw new FahnasFehler('E_TOTP', 'Zuerst die Zwei-Faktor-Anmeldung einrichten', { feld: 'code' });
        const r = totp.codePruefen(n.totp_ausstehend.geheimnis, p.code);
        if (!r.ok) throw new FahnasFehler('E_TOTP', 'Der Code ist falsch – prüfe Uhrzeit und App', { feld: 'code' });
        n.totp = { geheimnis: n.totp_ausstehend.geheimnis, wiederherstellung: hashes, letzter_schritt: r.schritt, aktiviert: new Date().toISOString() };
        delete n.totp_ausstehend;
      });
      geaendert();
      return { wiederherstellungscodes: codes };
    },
  });

  reg.aktion('nutzer.totp.entfernen', {
    rolle: 'nutzer', beschreibung: 'Zwei-Faktor-Anmeldung abschalten (mit eigenem Passwort bestätigen; Konsole ohne Passwort)',
    schema: { name: R.nutzername, passwort: S.passwortOptional },
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      await aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        await handelndenPruefen(daten, kontext, p.passwort);
        n.totp = null;
        delete n.totp_ausstehend;
      });
      geaendert();
      return { name: p.name, totp: false };
    },
  });

  reg.aktion('nutzer.totp.pruefen', {
    rolle: 'gast', beschreibung: 'Zweiten Faktor prüfen: TOTP-Code oder einmaliger Wiederherstellungscode',
    schema: { name: { typ: 'string', pflicht: true, max: 64 }, code: S.code },
    ausfuehren: async (p) => {
      // Prüfung und Verbrauch (Replay-Schutz, Wiederherstellungscode) unter der Sperre – derselbe Code darf nicht zweimal gelten
      return aendern(konfig, async (daten, merk) => {
        const n = finde(daten, p.name);
        if (!n || !n.totp || n.gesperrt) { merk.unveraendert = true; return { ok: false }; }
        const eingabe = p.code.replace(/\s/g, '');
        if (/^\d{6}$/.test(eingabe)) {
          const r = totp.codePruefen(n.totp.geheimnis, eingabe, { letzterSchritt: n.totp.letzter_schritt ?? -1 });
          if (!r.ok) { merk.unveraendert = true; return { ok: false }; }
          n.totp.letzter_schritt = r.schritt;
          n.letzte_anmeldung = new Date().toISOString();
          return { ok: true };
        }
        const e = await totp.wiederherstellungscodeEinloesen(n.totp.wiederherstellung, eingabe);
        if (!e.ok) { merk.unveraendert = true; return { ok: false }; }
        n.totp.wiederherstellung = e.rest;
        n.letzte_anmeldung = new Date().toISOString();
        return { ok: true, wiederherstellung: true, verbleibend: e.rest.length };
      });
    },
  });

  reg.aktion('nutzer.gruppen', {
    rolle: 'admin', schema: {}, beschreibung: 'Gruppen mit Mitgliedern',
    ausfuehren: async () => {
      const daten = await laden(konfig);
      return daten.gruppen.map((g) => ({ name: g.name, mitglieder: daten.nutzer.filter((n) => (n.gruppen || []).includes(g.name)).map((n) => n.name) }));
    },
  });

  reg.aktion('nutzer.gruppe.anlegen', {
    rolle: 'admin', beschreibung: 'Gruppe anlegen (Linux-Gruppe, für Freigabe-Rechte als @gruppe)',
    schema: { name: S.gruppenname },
    ausfuehren: async (p) => {
      if (RESERVIERT.has(p.name)) throw new FahnasFehler('E_PARAMS', `„${p.name}“ ist ein reservierter Name`, { feld: 'name' });
      await aendern(konfig, async (daten) => {
        if (daten.gruppen.some((g) => g.name === p.name)) throw new FahnasFehler('E_EXISTIERT', `Gruppe „${p.name}“ gibt es schon`, { feld: 'name' });
        if (finde(daten, p.name)) throw new FahnasFehler('E_EXISTIERT', `„${p.name}“ ist schon der Name eines Nutzers`, { feld: 'name' });
        if (await ln.gruppeExistiert(system, p.name)) throw new FahnasFehler('E_EXISTIERT', `Die Gruppe „${p.name}“ gibt es auf dem System schon`, { feld: 'name' });
        await ln.gruppeSicherstellen(system, p.name);
        daten.gruppen.push({ name: p.name, erstellt: new Date().toISOString() });
      });
      geaendert();
      return { name: p.name, mitglieder: [] };
    },
  });

  reg.aktion('nutzer.gruppe.loeschen', {
    rolle: 'admin', beschreibung: 'Gruppe löschen (Mitglieder verlieren nur die Gruppe, Freigaben verlieren @gruppe)',
    schema: { name: S.gruppenname },
    ausfuehren: async (p) => {
      await aendern(konfig, async (daten) => {
        if (!daten.gruppen.some((g) => g.name === p.name)) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Gruppe „${p.name}“ gibt es nicht`, { feld: 'name' });
        await ln.gruppeLoeschen(system, p.name);
        daten.gruppen = daten.gruppen.filter((g) => g.name !== p.name);
        for (const n of daten.nutzer) if ((n.gruppen || []).includes(p.name)) n.gruppen = n.gruppen.filter((g) => g !== p.name);
      });
      await gruppeAusFreigabenEntfernen(werkzeuge, p.name);
      try { await gruppeAusAppsEntfernen(werkzeuge, p.name); } catch (e) { process.stderr.write(`[nutzer] Apps bereinigen: ${e.message}\n`); }
      geaendert();
      return { name: p.name };
    },
  });

  // Persönliche Einstellungen je Nutzer (z. B. Anordnung der Übersichts-Kacheln): kleine JSON-Blöcke je Bereich,
  // nur für das eigene Konto (Admin darf fremde lesen/setzen). Grenze 32 KB je Bereich, damit users.json handlich bleibt.
  reg.aktion('nutzer.einstellungen.lesen', {
    rolle: 'nutzer', beschreibung: 'Persönliche Einstellungen eines Bereichs lesen (eigenes Konto)',
    schema: { name: R.nutzername, bereich: { typ: 'string', pflicht: true, muster: /^[a-z][a-z0-9_-]{0,31}$/, hinweis: 'Bereich: klein, a-z, 0-9, - und _' } },
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      const n = finde(await laden(konfig), p.name);
      if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
      return { bereich: p.bereich, wert: (n.einstellungen && n.einstellungen[p.bereich]) ?? null };
    },
  });
  reg.aktion('nutzer.einstellungen.setzen', {
    rolle: 'nutzer', beschreibung: 'Persönliche Einstellungen eines Bereichs speichern (eigenes Konto); wert null löscht',
    schema: { name: R.nutzername, bereich: { typ: 'string', pflicht: true, muster: /^[a-z][a-z0-9_-]{0,31}$/, hinweis: 'Bereich: klein, a-z, 0-9, - und _' }, wert: { typ: 'object' } },
    ausfuehren: async (p, kontext) => {
      nurSelbst(kontext, p.name);
      const text = p.wert === undefined ? '' : JSON.stringify(p.wert);
      if (text.length > 32 * 1024) throw new FahnasFehler('E_PARAMS', 'Einstellungen zu groß (max. 32 KB je Bereich)', { feld: 'wert' });
      return aendern(konfig, async (daten) => {
        const n = finde(daten, p.name);
        if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${p.name}“ gibt es nicht`, { feld: 'name' });
        n.einstellungen = n.einstellungen && typeof n.einstellungen === 'object' ? n.einstellungen : {};
        if (p.wert === undefined) delete n.einstellungen[p.bereich]; else n.einstellungen[p.bereich] = p.wert;
        return { bereich: p.bereich, wert: n.einstellungen[p.bereich] ?? null };
      });
    },
  });

  reg.aktion('nutzer.apply', {
    rolle: 'system', schema: {}, beschreibung: 'Nutzer und Gruppen idempotent ins System rendern',
    ausfuehren: async () => {
      const daten = await laden(konfig);
      const ergebnis = { nutzer: daten.nutzer.length, gruppen: daten.gruppen.length, angelegt: [], gruppen_angelegt: [], angepasst: [], warnungen: [] };
      for (const g of [ln.GRUPPE_NUTZER, ln.GRUPPE_ADMIN]) if (await ln.gruppeSicherstellen(system, g, true)) ergebnis.gruppen_angelegt.push(g);
      for (const g of daten.gruppen) if (await ln.gruppeSicherstellen(system, g.name)) ergebnis.gruppen_angelegt.push(g.name);
      const sambaKonten = await ln.sambaKonten(system);
      const verw = verwaltet(daten);
      const neueUids = new Map();
      for (const n of daten.nutzer) {
        let konto = await ln.linuxNutzer(system, n.name);
        if (!konto) {
          const r = await ln.nutzerAnlegen(system, { name: n.name, uid: n.uid || undefined, gruppen: sollGruppen(n) });
          konto = await ln.linuxNutzer(system, n.name);
          ergebnis.angelegt.push(n.name);
          if (n.uid && !r.uidUebernommen) ergebnis.warnungen.push(`Nutzer ${n.name}: alte uid ${n.uid} war vergeben, Dateien müssen ggf. neu zugeordnet werden`);
        }
        if (konto && konto.uid !== n.uid) { n.uid = konto.uid; neueUids.set(n.name, konto.uid); }
        const g = await ln.gruppenAngleichen(system, n.name, sollGruppen(n), verw);
        const s = await ln.shellAngleichen(system, n.name, istAktiverAdmin(n));
        if (g.ergaenzt.length || g.entfernt.length || s) ergebnis.angepasst.push(n.name);
        const sk = sambaKonten.get(n.name);
        if (!sk) {
          ergebnis.warnungen.push(`Nutzer ${n.name}: kein Samba-Passwort hinterlegt – bitte Passwort neu setzen`);
        } else if (n.gesperrt && !sk.flags.includes('D')) {
          await system.ausfuehren('smbpasswd', ['-d', n.name]); ergebnis.angepasst.push(n.name);
        } else if (!n.gesperrt && sk.flags.includes('D')) {
          await system.ausfuehren('smbpasswd', ['-e', n.name]); ergebnis.angepasst.push(n.name);
        }
      }
      // nur die uids nachtragen – unter der Sperre, ohne zwischenzeitliche Änderungen zu überschreiben
      if (neueUids.size) await aendern(konfig, (d) => { for (const n of d.nutzer) if (neueUids.has(n.name)) n.uid = neueUids.get(n.name); });
      ergebnis.angepasst = [...new Set(ergebnis.angepasst)];
      return ergebnis;
    },
  });
}
