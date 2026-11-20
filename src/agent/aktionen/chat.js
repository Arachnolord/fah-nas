// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat-Aktionen (Plan 02, Entwurf §5): Räume und Direktnachrichten, Nachrichten, Anhänge, Einladungen und Gäste,
// Chat-Einstellungen. Rechte prüft immer der Agent (Mitglied, Verwalter, Gast-Ausweis); Inhalte (Texte, Ausweise)
// kommen nie ins Prüfprotokoll (V1). Änderungen gehen als Agent-Ereignis `chat` mit Empfängerliste an den Web-Dienst.

import path from 'node:path';
import crypto from 'node:crypto';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { R, MUSTER_NUTZERNAME } from '../../gemeinsam/schema.js';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { freigabeHolen, pfadVorpruefen, helfer, idsFuer } from './dateien.js';
import { kopierenAls, stromKopieren } from '../helfer/kopieren_als.js';
import { metaLaden, hochladeTicket, leseTicket, ausDatei, aufraeumen } from '../chat/anhaenge.js';
import { anhangOrdner } from '../chat/ablage.js';
import { ablageSicherstellen, neueRaumId, neueGastId, neueEinladungId, dmId, raumOrdnerAnlegen, S } from '../chat/ablage.js';
import { laden, seite, suchen } from '../chat/verlauf.js';
import { senden, bearbeiten, nachrichtLoeschen, reaktion, gelesenSetzen, systemEintrag, ansicht, absenderName, reaktionenFuerGast, EMOJIS } from '../chat/nachrichten.js';
import { ausweisPruefen, einladungFinden, einladungGueltig, gastEntfernen, indexSetzen, hashVon, drossel } from '../chat/gaeste.js';
import { registriereAnruf } from '../chat/anruf.js';
import {
  raumLaden, raumAendern, alleRaeume, raumFuerNutzer, istVerwalter, istMitglied, empfaenger, nutzerDaten, anzeigename, raumLoeschen,
  chatEreignis, chatEinstellungen, EINSTELLUNGEN_DATEI, EINSTELLUNGEN_STANDARD,
} from '../chat/raeume.js';

const OHNE_STEUERZEICHEN = /^[^\u0000-\u001f\u007f]*$/;
const S_RAUMNAME = { typ: 'string', pflicht: true, min: 1, max: 80, muster: OHNE_STEUERZEICHEN, hinweis: 'Name: 1–80 Zeichen ohne Steuerzeichen' };
const S_BESCHREIBUNG = { typ: 'string', max: 300, muster: OHNE_STEUERZEICHEN, hinweis: 'Beschreibung: höchstens 300 Zeichen ohne Steuerzeichen' };
const S_NUTZER = { typ: 'string', max: 31, muster: MUSTER_NUTZERNAME, hinweis: 'Nutzername ungültig' };
const S_NAMEN = { typ: 'array', max: 100, elemente: S_NUTZER };

const S_TEXT = { typ: 'string', max: 10000 };
const S_EMOJI = { typ: 'string', pflicht: true, werte: EMOJIS };
const S_ANHAENGE = { typ: 'array', max: 10, elemente: { ...S.anhang } };

const jetztIso = () => new Date().toISOString();

/** Systemeintrag in den Verlauf (Beitritt, Austritt, Umbenennung …) – geht als Nachricht an alle Empfänger. */
async function systemZeile(w, raumId, art, wer = null, daten = null) {
  return systemEintrag(w, raumId, { art, wer, daten });
}

/** Kurzform eines Raums für Ereignisse an die Oberfläche (die lädt danach chat.uebersicht). */
function raumKurz(r) { return { id: r.id, art: r.art, name: r.name, beschreibung: r.beschreibung || '' }; }

/** Prüft, dass alle Namen bestehende, nicht gesperrte Nutzer sind. */
function nutzerPruefen(namen, liste, feld) {
  for (const n of liste) {
    const d = namen.get(n);
    if (!d || d.gesperrt) throw new FahnasFehler('E_PARAMS', `„${n}“ ist kein aktiver Nutzer`, { feld, name: n });
  }
}

/** Raum für Verwaltungsaktionen: Mitglied (sonst E_NICHT_GEFUNDEN), kein DM (E_PARAMS), Verwalter (E_RECHTE). */
async function raumZumVerwalten(w, raumId, k) {
  const r = await raumFuerNutzer(w, raumId, k);
  if (r.art === 'dm') throw new FahnasFehler('E_PARAMS', 'Direktnachrichten lassen sich nicht verwalten', { feld: 'raum' });
  if (!istVerwalter(r, k.nutzer)) throw new FahnasFehler('E_RECHTE', 'Das darf nur, wer den Raum verwaltet', { feld: 'raum' });
  return r;
}

/** Übersichtseintrag eines Raums aus Sicht von `nutzer`. */
function uebersichtEintrag(r, nutzer, namen, stummSet) {
  const andere = r.art === 'dm' ? Object.keys(r.mitglieder).find((n) => n !== nutzer) || nutzer : null;
  const dmName = r.art === 'dm' && andere === nutzer && r.partner_geloescht ? r.partner_geloescht.anzeigename : anzeigename(namen, andere);
  const letzte = r.letzte ? { id: r.letzte.id, zeit: r.letzte.zeit, kurz: r.letzte.kurz || '', von_name: absenderName(r, namen, r.letzte.von) } : null;
  return {
    id: r.id, art: r.art, name: r.art === 'dm' ? dmName : r.name, beschreibung: r.beschreibung || '', ...(r.geschlossen ? { geschlossen: true } : {}),
    mitglieder: Object.keys(r.mitglieder).filter((n) => namen.has(n)).sort().map((n) => ({ name: n, anzeigename: anzeigename(namen, n) })),
    gaeste: Object.entries(r.gaeste || {}).map(([id, g]) => ({ id, name: g.name })),
    ungelesen: (istMitglied(r, nutzer) && r.mitglieder[nutzer].ungelesen) || 0,
    letzte, verwalter: istVerwalter(r, nutzer), verwaltende: r.art === 'dm' ? [] : [...(r.verwalter || [])].filter((n) => namen.has(n)).sort(), stumm: stummSet.has(r.id),
  };
}

export function registriere(reg, w) {
  registriereAnruf(reg, w); // Anrufe (Plan 03)
  // ---- Räume und Direktnachrichten ---------------------------------------------------------------------------
  reg.aktion('chat.uebersicht', {
    rolle: 'nutzer', lesend: true, schema: {}, beschreibung: 'Eigene Chat-Räume und Direktnachrichten mit Ungelesen-Zähler',
    ausfuehren: async (_p, k) => {
      await ablageSicherstellen(w);
      const namen = await nutzerDaten(w);
      const eigen = namen.get(k.nutzer);
      const stumm = new Set((eigen && eigen.einstellungen && eigen.einstellungen.chat && Array.isArray(eigen.einstellungen.chat.stumm)) ? eigen.einstellungen.chat.stumm : []);
      const raeume = (await alleRaeume(w)).filter((r) => istMitglied(r, k.nutzer)).map((r) => uebersichtEintrag(r, k.nutzer, namen, stumm));
      raeume.sort((a, b) => String((b.letzte && b.letzte.zeit) || '').localeCompare(String((a.letzte && a.letzte.zeit) || '')) || a.name.localeCompare(b.name, 'de'));
      return { raeume };
    },
  });

  reg.aktion('chat.raum.anlegen', {
    rolle: 'nutzer', beschreibung: 'Chat-Raum anlegen (du verwaltest ihn)',
    audit: (p) => ({ name: p.name, mitglieder: p.mitglieder }),
    schema: { name: S_RAUMNAME, beschreibung: { ...S_BESCHREIBUNG, standard: '' }, mitglieder: { ...S_NAMEN, standard: [] } },
    ausfuehren: async (p, k) => {
      await ablageSicherstellen(w);
      const name = p.name.trim();
      if (!name) throw new FahnasFehler('E_PARAMS', 'Der Raum braucht einen Namen', { feld: 'name' });
      const namen = await nutzerDaten(w);
      const mitglieder = [...new Set([k.nutzer, ...p.mitglieder])];
      nutzerPruefen(namen, mitglieder.filter((n) => n !== k.nutzer), 'mitglieder');
      const id = neueRaumId(); const zeit = jetztIso();
      await raumOrdnerAnlegen(w, id);
      const r = await raumAendern(w, id, () => ({
        schema: 1, id, art: 'raum', name, beschreibung: p.beschreibung.trim(), erstellt: zeit, ersteller: k.nutzer, verwalter: [k.nutzer],
        mitglieder: Object.fromEntries(mitglieder.map((n) => [n, { seit: zeit, gelesen: null, ungelesen: 0 }])), gaeste: {}, einladungen: [], letzte: null,
      }));
      chatEreignis(w, r, 'raum', raumKurz(r));
      return { raum: id };
    },
  });

  reg.aktion('chat.raum.aendern', {
    rolle: 'nutzer', beschreibung: 'Name oder Beschreibung eines Raums ändern (Verwalter)',
    schema: { raum: S.raum, name: { ...S_RAUMNAME, pflicht: false }, beschreibung: S_BESCHREIBUNG },
    ausfuehren: async (p, k) => {
      await ablageSicherstellen(w);
      const alt = await raumZumVerwalten(w, p.raum, k);
      const name = p.name !== undefined ? p.name.trim() : alt.name;
      if (!name) throw new FahnasFehler('E_PARAMS', 'Der Raum braucht einen Namen', { feld: 'name' });
      const r = await raumAendern(w, p.raum, (d) => ({ ...d, name, beschreibung: p.beschreibung !== undefined ? p.beschreibung.trim() : d.beschreibung }));
      if (name !== alt.name) await systemZeile(w, p.raum, 'umbenannt', k.nutzer, { alt: alt.name, neu: name });
      chatEreignis(w, r, 'raum', raumKurz(r));
      return { raum: p.raum };
    },
  });

  reg.aktion('chat.raum.mitglieder', {
    rolle: 'nutzer', beschreibung: 'Mitglieder und Verwalter eines Raums ändern; jeder darf sich selbst entfernen',
    schema: { raum: S.raum, hinzu: S_NAMEN, weg: S_NAMEN, verwalter_hinzu: S_NAMEN, verwalter_weg: S_NAMEN },
    ausfuehren: async (p, k) => {
      await ablageSicherstellen(w);
      const alt = await raumFuerNutzer(w, p.raum, k);
      if (alt.art === 'dm') throw new FahnasFehler('E_PARAMS', 'Direktnachrichten haben feste Mitglieder', { feld: 'raum' });
      const hinzu = p.hinzu || []; const weg = p.weg || []; const vHinzu = p.verwalter_hinzu || []; const vWeg = p.verwalter_weg || [];
      // (1) Nicht-Verwalter dürfen nur sich selbst entfernen
      if (!istVerwalter(alt, k.nutzer)) {
        const nurSelbst = weg.length === 1 && weg[0] === k.nutzer && !hinzu.length && !vHinzu.length && !vWeg.length;
        if (!nurSelbst) throw new FahnasFehler('E_RECHTE', 'Das darf nur, wer den Raum verwaltet', { feld: 'raum' });
      }
      // (2) Hinzufügen: nur aktive Nutzer
      const namen = await nutzerDaten(w);
      nutzerPruefen(namen, hinzu, 'hinzu');
      const zeit = jetztIso();
      const neu = []; const entfernt = [];
      let ohneVerwalter = false;
      const r = await raumAendern(w, p.raum, (d) => {
        const x = { ...d, mitglieder: { ...d.mitglieder }, verwalter: [...(d.verwalter || [])] };
        for (const n of hinzu) if (!Object.hasOwn(x.mitglieder, n)) { x.mitglieder[n] = { seit: zeit, gelesen: null, ungelesen: 0 }; neu.push(n); }
        // (3) Entfernen verliert auch die Verwalterrolle
        for (const n of weg) if (Object.hasOwn(x.mitglieder, n)) { delete x.mitglieder[n]; x.verwalter = x.verwalter.filter((v) => v !== n); entfernt.push(n); }
        // (4) Verwalter nur aus Mitgliedern
        for (const n of vHinzu) {
          if (!Object.hasOwn(x.mitglieder, n)) throw new FahnasFehler('E_PARAMS', `„${n}“ ist kein Mitglied`, { feld: 'verwalter_hinzu', name: n });
          if (!x.verwalter.includes(n)) x.verwalter.push(n);
        }
        x.verwalter = x.verwalter.filter((v) => !vWeg.includes(v));
        // (5) Mitglieder ohne Verwalter gibt es nicht
        if (Object.keys(x.mitglieder).length && !x.verwalter.length) {
          throw new FahnasFehler('E_PARAMS', 'Bestimme zuerst jemand anderen zum Verwalter', { feld: 'weg' });
        }
        ohneVerwalter = !Object.keys(x.mitglieder).length;
        return x;
      });
      for (const n of neu) await systemZeile(w, p.raum, 'beitritt', n);
      for (const n of entfernt) await systemZeile(w, p.raum, 'austritt', n);
      // (6) Niemand mehr da → Raum weg
      if (ohneVerwalter) {
        await raumLoeschen(w, p.raum);
        chatEreignis(w, r, 'raum_weg', { raum: p.raum }, { an: { nutzer: entfernt.sort(), gaeste: Object.keys(r.gaeste || {}).sort() } });
        return { raum: p.raum, geloescht: true };
      }
      // (7) Ereignisse
      chatEreignis(w, r, 'raum', raumKurz(r));
      if (entfernt.length) chatEreignis(w, r, 'raum_weg', { raum: p.raum }, { an: { nutzer: entfernt.sort(), gaeste: [] } });
      return { raum: p.raum };
    },
  });

  reg.aktion('chat.raum.loeschen', {
    rolle: 'nutzer', beschreibung: 'Raum samt Verlauf und Anhängen löschen (Verwalter oder Admin)',
    schema: { raum: S.raum },
    ausfuehren: async (p, k) => {
      await ablageSicherstellen(w);
      const admin = k.rolle === 'admin' || k.rolle === 'system';
      const r = await raumLaden(w, p.raum);
      if (!r || (!admin && !istMitglied(r, k.nutzer))) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Raum gibt es nicht', { feld: 'raum' });
      if (r.art === 'dm') throw new FahnasFehler('E_PARAMS', 'Direktnachrichten lassen sich nicht löschen – nur einzelne Nachrichten', { feld: 'raum' });
      if (!admin && !istVerwalter(r, k.nutzer)) throw new FahnasFehler('E_RECHTE', 'Das darf nur, wer den Raum verwaltet', { feld: 'raum' });
      const an = empfaenger(r);
      await raumLoeschen(w, p.raum);
      chatEreignis(w, r, 'raum_weg', { raum: p.raum }, { an });
      return { geloescht: true };
    },
  });

  reg.aktion('chat.raum.alle', {
    rolle: 'admin', lesend: true, schema: {}, beschreibung: 'Alle Räume ohne Inhalte (zum Löschen durch Admins)',
    ausfuehren: async () => {
      await ablageSicherstellen(w);
      return (await alleRaeume(w)).filter((r) => r.art === 'raum').map((r) => ({
        id: r.id, name: r.name, mitglieder_anzahl: Object.keys(r.mitglieder || {}).length, gaeste_anzahl: Object.keys(r.gaeste || {}).length,
        ersteller: r.ersteller || null, letzte_zeit: (r.letzte && r.letzte.zeit) || null,
      })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    },
  });

  reg.aktion('chat.dm.oeffnen', {
    rolle: 'nutzer', beschreibung: 'Direktnachricht mit einem anderen Nutzer öffnen (legt sie beim ersten Mal an)',
    schema: { nutzer: { ...S_NUTZER, pflicht: true } },
    ausfuehren: async (p, k) => {
      await ablageSicherstellen(w);
      if (p.nutzer === k.nutzer) throw new FahnasFehler('E_PARAMS', 'Mit dir selbst kannst du nicht schreiben', { feld: 'nutzer' });
      const namen = await nutzerDaten(w);
      nutzerPruefen(namen, [p.nutzer], 'nutzer');
      // Erste DM-Kennung, die frei ist oder beiden gehört; geschlossene DMs (Konto gelöscht) werden übersprungen
      const passt = (x) => !x.geschlossen && istMitglied(x, k.nutzer) && istMitglied(x, p.nutzer);
      for (let folge = 0; folge < 100; folge++) {
        const id = dmId(k.nutzer, p.nutzer, folge);
        const vorhanden = await raumLaden(w, id);
        if (vorhanden) { if (passt(vorhanden)) return { raum: id }; continue; }
        const zeit = jetztIso();
        await raumOrdnerAnlegen(w, id);
        let neu = false;
        const r = await raumAendern(w, id, (d) => {
          if (d) return d; // gleichzeitig angelegt
          neu = true;
          return {
            schema: 1, id, art: 'dm', name: '', beschreibung: '', erstellt: zeit, ersteller: k.nutzer, verwalter: [],
            mitglieder: { [k.nutzer]: { seit: zeit, gelesen: null, ungelesen: 0 }, [p.nutzer]: { seit: zeit, gelesen: null, ungelesen: 0 } }, gaeste: {}, einladungen: [], letzte: null,
          };
        });
        if (!passt(r)) continue;
        if (neu) chatEreignis(w, r, 'raum', raumKurz(r));
        return { raum: id };
      }
      throw new FahnasFehler('E_SYSTEM', 'Für diese Direktnachricht ist keine Kennung mehr frei');
    },
  });

  reg.aktion('chat.personen', {
    rolle: 'nutzer', lesend: true, audit: false, schema: {}, beschreibung: 'NAS-Nutzer zum Anschreiben und Einladen (ohne gesperrte)',
    ausfuehren: async () => {
      const namen = await nutzerDaten(w);
      const personen = [...namen.entries()].filter(([, d]) => !d.gesperrt).map(([name]) => ({ name, anzeigename: anzeigename(namen, name) }));
      personen.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      return { personen };
    },
  });

  reg.aktion('chat.empfaenger', {
    rolle: 'nutzer', lesend: true, audit: false, schema: { raum: S.raum }, beschreibung: 'Empfänger eines Raums (für „tippt“ und Anrufe)',
    ausfuehren: async (p, k) => empfaenger(await raumFuerNutzer(w, p.raum, k)),
  });

  // ---- Nachrichten ----------------------------------------------------------------------------------------------
  reg.aktion('chat.verlauf', {
    rolle: 'nutzer', lesend: true, beschreibung: 'Nachrichten eines Raums (blättern mit vor)',
    schema: { raum: S.raum, vor: { ...S.nachricht, pflicht: false }, anzahl: { typ: 'integer', min: 1, max: 100, standard: 50 } },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      const z = await laden(w, r.id);
      const { liste, mehr } = seite(z, { vor: p.vor ?? null, anzahl: p.anzahl });
      const namen = await nutzerDaten(w);
      const nachrichten = [];
      for (const n of liste) nachrichten.push(await ansicht(w, r, n, { namen, zustand: z }));
      const gelesen = Object.fromEntries(Object.entries(r.mitglieder).map(([n, m]) => [n, m.gelesen ?? null]));
      return { nachrichten, mehr, gelesen };
    },
  });

  reg.aktion('chat.senden', {
    rolle: 'nutzer', audit: false, beschreibung: 'Nachricht in einen Raum senden',
    schema: { raum: S.raum, text: { ...S_TEXT, standard: '' }, antwort: { ...S.nachricht, pflicht: false }, anhaenge: { ...S_ANHAENGE, standard: [] }, aktiv: { ...S_NAMEN, standard: [] } },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      if (r.geschlossen) throw new FahnasFehler('E_PARAMS', 'Dieses Konto gibt es nicht mehr – der Verlauf bleibt lesbar', { feld: 'raum' });
      return { nachricht: await senden(w, r, { von: k.nutzer, text: p.text, antwort: p.antwort ?? null, anhaenge: p.anhaenge, aktiv: p.aktiv }) };
    },
  });

  reg.aktion('chat.bearbeiten', {
    rolle: 'nutzer', audit: false, beschreibung: 'Eigene Nachricht bearbeiten',
    schema: { raum: S.raum, nachricht: S.nachricht, text: { ...S_TEXT, pflicht: true } },
    ausfuehren: async (p, k) => ({ nachricht: await bearbeiten(w, await raumFuerNutzer(w, p.raum, k), p.nachricht, k.nutzer, p.text) }),
  });

  reg.aktion('chat.loeschen', {
    rolle: 'nutzer', beschreibung: 'Nachricht löschen (eigene; wer den Raum verwaltet, auch fremde)',
    schema: { raum: S.raum, nachricht: S.nachricht },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      await nachrichtLoeschen(w, r, p.nachricht, k.nutzer, { verwalter: istVerwalter(r, k.nutzer) });
      return { geloescht: true };
    },
  });

  reg.aktion('chat.reaktion', {
    rolle: 'nutzer', audit: false, beschreibung: 'Reaktion (Emoji) auf eine Nachricht setzen oder entfernen',
    schema: { raum: S.raum, nachricht: S.nachricht, emoji: S_EMOJI, an: { typ: 'boolean', pflicht: true } },
    ausfuehren: async (p, k) => ({ reaktionen: await reaktion(w, await raumFuerNutzer(w, p.raum, k), p.nachricht, k.nutzer, p.emoji, p.an) }),
  });

  reg.aktion('chat.gelesen', {
    rolle: 'nutzer', audit: false, beschreibung: 'Lesestand in einem Raum setzen',
    schema: { raum: S.raum, bis: S.nachricht },
    ausfuehren: async (p, k) => gelesenSetzen(w, await raumFuerNutzer(w, p.raum, k), k.nutzer, p.bis),
  });

  reg.aktion('chat.suche', {
    rolle: 'nutzer', lesend: true, audit: (p) => ({ raum: p.raum }), beschreibung: 'Im Verlauf eines Raums suchen',
    schema: { raum: S.raum, text: { typ: 'string', pflicht: true, min: 2, max: 100 } },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      const z = await laden(w, r.id);
      const namen = await nutzerDaten(w);
      const treffer = [];
      for (const n of suchen(z, p.text)) treffer.push(await ansicht(w, r, n, { namen, zustand: z }));
      return { treffer };
    },
  });

  // ---- Anhänge ------------------------------------------------------------------------------------------------
  const S_VORSCHAU = { typ: 'integer', werte: [128, 256, 512] };

  /** Anhang, den `nutzer` sehen darf: gebunden an eine Nachricht des Raums oder selbst hochgeladen – sonst E_NICHT_GEFUNDEN. */
  async function sichtbarerAnhang(raum, anhangId, nutzer) {
    const m = await metaLaden(w, raum.id, anhangId);
    if (!m || (m.nachricht === null && m.von !== nutzer)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Anhang gibt es nicht', { feld: 'anhang' });
    return m;
  }

  reg.aktion('chat.anhang.ticket', {
    rolle: 'nutzer', beschreibung: 'Datei für eine Nachricht hochladen (Ticket für den Datenkanal)',
    schema: { raum: S.raum, name: { typ: 'string', pflicht: true, max: 255 }, groesse: { typ: 'integer', pflicht: true, min: 0 } },
    ausfuehren: async (p, k) => hochladeTicket(w, await raumFuerNutzer(w, p.raum, k), { von: k.nutzer, ticketNutzer: k.nutzer, name: p.name, groesse: p.groesse }),
  });

  reg.aktion('chat.anhang.lesen', {
    rolle: 'nutzer', lesend: true, beschreibung: 'Anhang herunterladen (Ticket) oder Vorschaubild',
    schema: { raum: S.raum, anhang: S.anhang, vorschau: S_VORSCHAU },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      await sichtbarerAnhang(r, p.anhang, k.nutzer);
      return leseTicket(w, r, p.anhang, { ticketNutzer: k.nutzer, vorschau: p.vorschau ?? null });
    },
  });

  reg.aktion('chat.anhang.speichern', {
    rolle: 'nutzer', beschreibung: 'Anhang als du selbst in einem Ordner auf dem NAS ablegen',
    schema: { raum: S.raum, anhang: S.anhang, freigabe: R.freigabename, ordner: R.pfad },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      const m = await sichtbarerAnhang(r, p.anhang, k.nutzer);
      if (m.nachricht === null) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Anhang gibt es nicht', { feld: 'anhang' });
      const fr = await freigabeHolen(w, p.freigabe, k, true);
      const { abs } = await pfadVorpruefen(fr.wurzel, p.ordner);
      const erg = await kopierenAls(w, { quelleAbs: path.join(anhangOrdner(w, r.id), m.id), quelleIds: { uid: 0, gid: 0, gruppen: [] }, zielOrdnerAbs: abs, zielName: m.name, zielKontext: k });
      return { freigabe: p.freigabe, pfad: path.relative(fr.wurzel, erg.pfad), name: erg.name };
    },
  });

  reg.aktion('chat.anhang.aus_nas', {
    rolle: 'nutzer', beschreibung: 'Datei aus einer Freigabe in den Chat kopieren („Im Chat teilen …“)',
    schema: { raum: S.raum, freigabe: R.freigabename, pfad: R.pfad },
    ausfuehren: async (p, k) => {
      const r = await raumFuerNutzer(w, p.raum, k);
      const fr = await freigabeHolen(w, p.freigabe, k);
      const { rel, abs } = await pfadVorpruefen(fr.wurzel, p.pfad);
      if (rel === '') throw new FahnasFehler('E_PARAMS', 'Bitte eine Datei wählen', { feld: 'pfad' });
      const info = await helfer(w, k, 'info', { wurzel: fr.wurzel, pfad: rel });
      if (info.art !== 'datei') throw new FahnasFehler('E_PARAMS', 'Nur einzelne Dateien lassen sich teilen', { feld: 'pfad' });
      const anhang = await ausDatei(w, r, { von: k.nutzer, quelleAbs: abs, quelleIds: await idsFuer(w, k, fr.wurzel), name: path.basename(rel), groesse: info.groesse, stromKopieren });
      return { anhang };
    },
  });

  // ---- Einladungen (Verwalter) und Beitritt von NAS-Nutzern ---------------------------------------------------
  const einladungAnsicht = (e) => ({ id: e.id, token: e.token, url: `/einladung/${e.token}`, ablauf: e.ablauf, max: e.max ?? null, beitritte: e.beitritte || 0, erstellt: e.erstellt });
  const anVerwalter = (r) => ({ an: { nutzer: [...(r.verwalter || [])].sort(), gaeste: [] } });

  reg.aktion('chat.einladung.anlegen', {
    rolle: 'nutzer', beschreibung: 'Einladungslink für einen Raum erzeugen (Verwalter)',
    audit: (p) => ({ raum: p.raum, gueltig_h: p.gueltig_h, max_beitritte: p.max_beitritte }),
    schema: { raum: S.raum, gueltig_h: { typ: 'integer', pflicht: true, min: 0, max: 8760 }, max_beitritte: { typ: 'integer', min: 1, max: 1000 } },
    ausfuehren: async (p, k) => {
      await raumZumVerwalten(w, p.raum, k);
      const erstellt = jetztIso();
      const e = {
        id: neueEinladungId(), token: crypto.randomBytes(32).toString('base64url'), erstellt, von: k.nutzer,
        ablauf: p.gueltig_h ? new Date(Date.parse(erstellt) + p.gueltig_h * 3_600_000).toISOString() : null, max: p.max_beitritte ?? null, beitritte: 0,
      };
      const r = await raumAendern(w, p.raum, (d) => ({ ...d, einladungen: [...(d.einladungen || []), e] }));
      chatEreignis(w, r, 'einladungen', { raum: r.id }, anVerwalter(r));
      return einladungAnsicht(e);
    },
  });

  reg.aktion('chat.einladung.liste', {
    rolle: 'nutzer', lesend: true, schema: { raum: S.raum }, beschreibung: 'Einladungslinks eines Raums (Verwalter)',
    ausfuehren: async (p, k) => ((await raumZumVerwalten(w, p.raum, k)).einladungen || []).map(einladungAnsicht),
  });

  reg.aktion('chat.einladung.loeschen', {
    rolle: 'nutzer', schema: { raum: S.raum, id: S.einladung }, beschreibung: 'Einladungslink löschen (Verwalter); Beigetretene bleiben',
    ausfuehren: async (p, k) => {
      await raumZumVerwalten(w, p.raum, k);
      const r = await raumAendern(w, p.raum, (d) => {
        if (!(d.einladungen || []).some((x) => x.id === p.id)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gibt es nicht', { feld: 'id' });
        return { ...d, einladungen: d.einladungen.filter((x) => x.id !== p.id) };
      });
      chatEreignis(w, r, 'einladungen', { raum: r.id }, anVerwalter(r));
      return { geloescht: true };
    },
  });

  reg.aktion('chat.gast.entfernen', {
    rolle: 'nutzer', schema: { raum: S.raum, gast: S.gast, link_sperren: { typ: 'boolean', standard: false } },
    beschreibung: 'Gast aus einem Raum entfernen (Verwalter); mit link_sperren auch seinen Einladungslink löschen',
    ausfuehren: async (p, k) => {
      const r = await raumZumVerwalten(w, p.raum, k);
      const einladung = r.gaeste && Object.hasOwn(r.gaeste, p.gast) ? r.gaeste[p.gast].einladung : null;
      await systemZeile(w, r.id, 'gast_entfernt', `gast:${p.gast}`);
      await gastEntfernen(w, r, p.gast);
      // Ohne gelöschten Link käme der Gast mit demselben Link als neuer Gast zurück (Prüfbericht Plan 02, Befund 10)
      let linkGeloescht = false;
      if (p.link_sperren && einladung) {
        const neu = await raumAendern(w, r.id, (d) => {
          if (!d || !(d.einladungen || []).some((x) => x.id === einladung)) return UNVERAENDERT;
          linkGeloescht = true;
          return { ...d, einladungen: d.einladungen.filter((x) => x.id !== einladung) };
        });
        if (linkGeloescht) chatEreignis(w, neu, 'einladungen', { raum: neu.id }, anVerwalter(neu));
      }
      return { entfernt: true, link_geloescht: linkGeloescht };
    },
  });

  reg.aktion('chat.einladung.annehmen', {
    rolle: 'nutzer', schema: { token: S.token }, beschreibung: 'Einladung als NAS-Nutzer annehmen', audit: () => ({}),
    ausfuehren: async (p, k) => {
      await ablageSicherstellen(w);
      const { raum: r0, einladung } = await einladungFinden(w, p.token);
      if (istMitglied(r0, k.nutzer)) return { raum: r0.id };
      const zeit = jetztIso();
      const r = await raumAendern(w, r0.id, (d) => {
        if (istMitglied(d, k.nutzer)) return d;
        const e = (d.einladungen || []).find((x) => x.id === einladung.id);
        if (!einladungGueltig(e)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)', { feld: 'token' });
        return { ...d, mitglieder: { ...d.mitglieder, [k.nutzer]: { seit: zeit, gelesen: null, ungelesen: 0 } }, einladungen: d.einladungen.map((x) => (x.id === e.id ? { ...x, beitritte: (x.beitritte || 0) + 1 } : x)) };
      });
      await systemZeile(w, r.id, 'beitritt', k.nutzer);
      chatEreignis(w, r, 'raum', raumKurz(r));
      return { raum: r.id };
    },
  });

  // ---- Gäste (Rolle gast: nur der Web-Dienst ruft sie auf; jede Aktion prüft den Ausweis) ---------------------
  const ohneAusweis = (p) => { const { ausweis: _a, text: _t, ...rest } = p; return rest; };
  const OHNE_STEUER_NAME = /^[^\u0000-\u001f\u007f]{1,40}$/;
  /** Ausweis prüfen und sicherstellen, dass der Gast nur seinen eigenen Raum anspricht. */
  async function gastRaum(p) {
    const a = await ausweisPruefen(w, p.ausweis);
    if (p.raum !== undefined && p.raum !== a.raum.id) throw new FahnasFehler('E_RECHTE', 'Kein Zugriff auf diesen Raum', { feld: 'raum' });
    return a;
  }

  reg.aktion('chat.gast.einladung', {
    rolle: 'gast', lesend: true, schema: { token: S.token }, beschreibung: 'Einladung prüfen (Name des Raums)', audit: () => ({}),
    ausfuehren: async (p) => { const { raum: r } = await einladungFinden(w, p.token); return { raum: r.id, raum_name: r.name, gueltig: true }; },
  });

  reg.aktion('chat.gast.beitreten', {
    rolle: 'gast', beschreibung: 'Als Gast über einen Einladungslink beitreten', audit: (p) => ({ name: p.name }),
    schema: { token: S.token, name: { typ: 'string', pflicht: true, max: 200 } },
    ausfuehren: async (p) => {
      await ablageSicherstellen(w);
      const name = p.name.trim();
      if (!OHNE_STEUER_NAME.test(name)) throw new FahnasFehler('E_PARAMS', 'Name: 1–40 Zeichen ohne Steuerzeichen', { feld: 'name' });
      const { raum: r0, einladung } = await einladungFinden(w, p.token);
      const gastId = neueGastId(); const geheimnis = crypto.randomBytes(32).toString('base64url'); const seit = jetztIso();
      const r = await raumAendern(w, r0.id, (d) => {
        const e = (d.einladungen || []).find((x) => x.id === einladung.id);
        if (!einladungGueltig(e)) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diese Einladung gilt nicht (mehr)', { feld: 'token' });
        return {
          ...d, gaeste: { ...(d.gaeste || {}), [gastId]: { name, seit, geheimnis_hash: hashVon(geheimnis), gelesen: null, ungelesen: 0, einladung: e.id } },
          einladungen: d.einladungen.map((x) => (x.id === e.id ? { ...x, beitritte: (x.beitritte || 0) + 1 } : x)),
        };
      });
      await indexSetzen(w, gastId, r.id);
      await systemZeile(w, r.id, 'gast_beitritt', `gast:${gastId}`);
      chatEreignis(w, r, 'raum', raumKurz(r));
      return { ausweis: { id: gastId, geheimnis }, raum: r.id };
    },
  });

  reg.aktion('chat.gast.pruefen', {
    rolle: 'gast', lesend: true, schema: { ausweis: S.ausweis }, beschreibung: 'Gast-Ausweis prüfen', audit: () => ({}),
    ausfuehren: async (p) => { const a = await ausweisPruefen(w, p.ausweis); return { raum: a.raum.id, raum_name: a.raum.name, name: a.gast.name, gast: a.gastId }; },
  });

  reg.aktion('chat.gast.verlauf', {
    rolle: 'gast', lesend: true, audit: ohneAusweis, beschreibung: 'Verlauf für einen Gast (ab seinem Beitritt, ohne Login-Namen)',
    schema: { ausweis: S.ausweis, raum: S.raum, vor: { ...S.nachricht, pflicht: false }, anzahl: { typ: 'integer', min: 1, max: 100, standard: 50 } },
    ausfuehren: async (p) => {
      const a = await gastRaum(p);
      const z = await laden(w, a.raum.id);
      const { liste, mehr } = seite(z, { vor: p.vor ?? null, anzahl: p.anzahl, ab: a.gast.seit });
      const namen = await nutzerDaten(w);
      const nachrichten = [];
      for (const n of liste) nachrichten.push(await ansicht(w, a.raum, n, { namen, zustand: z, fuerGast: true, gastSeit: a.gast.seit }));
      return { nachrichten, mehr };
    },
  });

  reg.aktion('chat.gast.senden', {
    rolle: 'gast', audit: false, beschreibung: 'Nachricht als Gast senden',
    schema: { ausweis: S.ausweis, raum: S.raum, text: { ...S_TEXT, standard: '' }, antwort: { ...S.nachricht, pflicht: false }, anhaenge: { ...S_ANHAENGE, standard: [] }, aktiv: { ...S_NAMEN, standard: [] } },
    ausfuehren: async (p) => {
      const a = await gastRaum(p);
      drossel(a.gastId, 'nachricht', 60_000, 20);
      return { nachricht: await senden(w, a.raum, { von: `gast:${a.gastId}`, vonName: a.gast.name, text: p.text, antwort: p.antwort ?? null, anhaenge: p.anhaenge, aktiv: p.aktiv, gast: a.gast }) };
    },
  });

  reg.aktion('chat.gast.loeschen', {
    rolle: 'gast', audit: ohneAusweis, beschreibung: 'Eigene Nachricht als Gast löschen',
    schema: { ausweis: S.ausweis, raum: S.raum, nachricht: S.nachricht },
    ausfuehren: async (p) => { const a = await gastRaum(p); await nachrichtLoeschen(w, a.raum, p.nachricht, `gast:${a.gastId}`, { gast: a.gast }); return { geloescht: true }; },
  });

  reg.aktion('chat.gast.reaktion', {
    rolle: 'gast', audit: false, beschreibung: 'Reaktion als Gast',
    schema: { ausweis: S.ausweis, raum: S.raum, nachricht: S.nachricht, emoji: S_EMOJI, an: { typ: 'boolean', pflicht: true } },
    ausfuehren: async (p) => {
      const a = await gastRaum(p);
      drossel(a.gastId, 'reaktion', 60_000, 60);
      const r = await reaktion(w, a.raum, p.nachricht, `gast:${a.gastId}`, p.emoji, p.an, { gast: a.gast });
      return { reaktionen: reaktionenFuerGast(a.raum, await nutzerDaten(w), r) };
    },
  });

  reg.aktion('chat.gast.gelesen', {
    rolle: 'gast', audit: false, beschreibung: 'Lesestand als Gast setzen',
    schema: { ausweis: S.ausweis, raum: S.raum, bis: S.nachricht },
    ausfuehren: async (p) => { const a = await gastRaum(p); return gelesenSetzen(w, a.raum, a.gastId, p.bis, { gast: true }); },
  });

  reg.aktion('chat.gast.anhang_ticket', {
    rolle: 'gast', audit: ohneAusweis, beschreibung: 'Datei als Gast hochladen (Ticket)',
    schema: { ausweis: S.ausweis, raum: S.raum, name: { typ: 'string', pflicht: true, max: 255 }, groesse: { typ: 'integer', pflicht: true, min: 0 } },
    ausfuehren: async (p) => {
      const a = await gastRaum(p);
      drossel(a.gastId, 'ticket', 3_600_000, 20);
      return hochladeTicket(w, a.raum, { von: `gast:${a.gastId}`, ticketNutzer: `gast:${a.gastId}`, name: p.name, groesse: p.groesse });
    },
  });

  reg.aktion('chat.gast.anhang_lesen', {
    rolle: 'gast', lesend: true, audit: ohneAusweis, beschreibung: 'Anhang als Gast lesen (nur ab Beitritt bzw. eigene)',
    schema: { ausweis: S.ausweis, raum: S.raum, anhang: S.anhang, vorschau: S_VORSCHAU },
    ausfuehren: async (p) => {
      const a = await gastRaum(p);
      const m = await metaLaden(w, a.raum.id, p.anhang);
      const ich = `gast:${a.gastId}`;
      let sichtbar = false;
      if (m && m.nachricht === null) sichtbar = m.von === ich;
      else if (m) { const n = (await laden(w, a.raum.id)).nachrichten.get(m.nachricht); sichtbar = !!n && !n.geloescht && String(n.zeit) >= a.gast.seit; }
      if (!sichtbar) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Diesen Anhang gibt es nicht', { feld: 'anhang' });
      return leseTicket(w, a.raum, p.anhang, { ticketNutzer: ich, vorschau: p.vorschau ?? null });
    },
  });

  reg.aktion('chat.gast.verlassen', {
    rolle: 'gast', audit: ohneAusweis, schema: { ausweis: S.ausweis }, beschreibung: 'Raum als Gast verlassen (endgültig)',
    ausfuehren: async (p) => {
      const a = await ausweisPruefen(w, p.ausweis);
      await systemZeile(w, a.raum.id, 'austritt', `gast:${a.gastId}`);
      await gastEntfernen(w, a.raum, a.gastId);
      return { verlassen: true };
    },
  });

  reg.aktion('chat.gast.empfaenger', {
    rolle: 'gast', lesend: true, audit: false, schema: { ausweis: S.ausweis, raum: S.raum }, beschreibung: 'Empfänger des eigenen Raums (Gast)',
    ausfuehren: async (p) => empfaenger((await gastRaum(p)).raum),
  });

  // ---- Einstellungen ------------------------------------------------------------------------------------------
  reg.aktion('chat.einstellungen.lesen', {
    rolle: 'nutzer', lesend: true, schema: {}, beschreibung: 'Chat-Einstellungen (größter Anhang, Anrufe von unterwegs)',
    ausfuehren: async () => chatEinstellungen(w),
  });

  reg.aktion('chat.einstellungen.setzen', {
    rolle: 'admin', beschreibung: 'Chat-Einstellungen ändern (größter Anhang, Vermittlungsdienst für Anrufe)',
    schema: {
      max_anhang_mb: { typ: 'integer', min: 1, max: 20480 },
      turn: { typ: 'object', felder: { aktiv: { typ: 'boolean', pflicht: true }, port: { typ: 'integer', pflicht: true, min: 1024, max: 65535 } } },
    },
    ausfuehren: async (p) => {
      const alt = await chatEinstellungen(w);
      const neu = { version: EINSTELLUNGEN_STANDARD.version, max_anhang_mb: p.max_anhang_mb ?? alt.max_anhang_mb, turn: p.turn ? { aktiv: p.turn.aktiv, port: p.turn.port } : alt.turn };
      await w.konfig.speichern(EINSTELLUNGEN_DATEI, neu);
      w.konfigGeaendert?.('chat');
      return { max_anhang_mb: neu.max_anhang_mb, turn: neu.turn };
    },
  });
}

let aufraeumErst = null; let aufraeumTakt = null;

export async function starten(w) {
  await ablageSicherstellen(w);
  const lauf = () => aufraeumen(w).catch((e) => process.stderr.write(`[chat] Aufräumen: ${e.message}\n`));
  aufraeumErst = setTimeout(lauf, 10 * 60_000); aufraeumErst.unref();
  aufraeumTakt = setInterval(lauf, 24 * 3_600_000); aufraeumTakt.unref();
}

export async function stoppen() {
  if (aufraeumErst) clearTimeout(aufraeumErst);
  if (aufraeumTakt) clearInterval(aufraeumTakt);
  aufraeumErst = null; aufraeumTakt = null;
}
