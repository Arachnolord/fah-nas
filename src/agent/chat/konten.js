// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Chat beim Löschen eines Kontos (Prüfbericht Plan 02, Befund 5): Mitgliedschaft und DM-Kennung hängen am Namen –
// ein neuer gleichnamiger Nutzer darf weder Räume noch Direktnachrichten des Vorgängers erben. Räume: austragen, leere
// Räume löschen, fehlt danach ein Verwalter, rückt das dienstälteste Mitglied nach. DMs: geschlossen, der Verlauf bleibt
// für den Partner lesbar; eine neue DM bekommt eine neue Kennung (ablage.js dmId mit Folgenummer).

import fs from 'node:fs/promises';
import path from 'node:path';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { alleRaeume, raumAendern, raumLoeschen, raumLaden, raumVergessen, chatEreignis, istMitglied, GAESTE_DATEI } from './raeume.js';
import { systemEintrag } from './nachrichten.js';
import { chatKonfig, dmId, raumOrdner, anhangOrdner, DATEIMODUS } from './ablage.js';
import { umschreiben, exklusiv } from './verlauf.js';

const kurzform = (r) => ({ id: r.id, art: r.art, name: r.name, beschreibung: r.beschreibung || '' });

/** Konto `name` (Anzeigename `anzeigename` für geschlossene DMs) aus allen Räumen nehmen. Wirft nie. */
export async function nutzerAusChatEntfernen(w, name, anzeigename = name) {
  let raeume = [];
  try { raeume = await alleRaeume(w); } catch (e) { process.stderr.write(`[chat] Konto ${name}: ${e.message}\n`); return; }
  for (const r of raeume) {
    if (!istMitglied(r, name)) continue;
    try {
      let leer = false;
      const neu = await raumAendern(w, r.id, (d) => {
        if (!d || !istMitglied(d, name)) return UNVERAENDERT;
        const x = { ...d, mitglieder: { ...d.mitglieder }, verwalter: (d.verwalter || []).filter((v) => v !== name) };
        delete x.mitglieder[name];
        if (x.art === 'dm') return { ...x, geschlossen: true, partner_geloescht: { name, anzeigename } };
        const rest = Object.keys(x.mitglieder).sort((a, b) => String(x.mitglieder[a].seit).localeCompare(String(x.mitglieder[b].seit)) || a.localeCompare(b));
        if (!rest.length) leer = true;
        else if (!x.verwalter.length) x.verwalter = [rest[0]];
        return x;
      });
      if (leer) {
        await raumLoeschen(w, r.id);
        chatEreignis(w, neu, 'raum_weg', { raum: r.id }, { an: { nutzer: [], gaeste: Object.keys(neu.gaeste || {}).sort() } });
        continue;
      }
      await systemEintrag(w, r.id, { art: 'austritt', wer: name });
      chatEreignis(w, neu, 'raum', kurzform(neu));
    } catch (e) {
      process.stderr.write(`[chat] Konto ${name} aus Raum ${r.id}: ${e.message}\n`);
    }
  }
}

/** Anhang-Metadaten (<id>.json) eines Raums: Hochlader `von` umbenennen. */
async function anhaengeUmbenennen(w, raumId, alt, neu) {
  const ordner = anhangOrdner(w, raumId);
  let namen = [];
  try { namen = (await fs.readdir(ordner)).filter((d) => /^a[A-Za-z0-9_-]{16}\.json$/.test(d)); } catch { return; }
  for (const d of namen) {
    const datei = path.join(ordner, d);
    let m; try { m = JSON.parse(await fs.readFile(datei, 'utf8')); } catch { continue; }
    if (!m || m.von !== alt) continue;
    const zwischen = `${datei}.${process.pid}.umbenannt`;
    await fs.writeFile(zwischen, JSON.stringify({ ...m, von: neu }) + '\n', { mode: DATEIMODUS });
    await fs.rename(zwischen, datei);
  }
}

/** Direktnachricht an ihre neue Kennung umziehen (Ordner, Anhänge, raum.json.id, Gast-Index, Zwischenspeicher). */
async function dmUmziehen(w, raum, ziel) {
  await exklusiv(raum.id, async () => {
    await fs.rename(raumOrdner(w, raum.id), raumOrdner(w, ziel));
    try { await fs.rename(anhangOrdner(w, raum.id), anhangOrdner(w, ziel)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  });
  raumVergessen(w, raum.id);
  const neu = await raumAendern(w, ziel, (d) => (d ? { ...d, id: ziel } : UNVERAENDERT));
  try {
    await chatKonfig(w).aendern(GAESTE_DATEI, (d) => {
      const x = { ...(d || {}) }; let anders = false;
      for (const [g, r] of Object.entries(x)) if (r === raum.id) { x[g] = ziel; anders = true; }
      return anders ? x : UNVERAENDERT;
    }, {}, DATEIMODUS);
  } catch (e) { process.stderr.write(`[chat] Gast-Index ${raum.id} → ${ziel}: ${e.message}\n`); }
  chatEreignis(w, raum, 'raum_weg', { raum: raum.id });
  chatEreignis(w, neu, 'raum', kurzform(neu));
  return neu;
}

/**
 * Konto umbenannt (Betreiber 20.10.2026): Mitgliedschaften samt Lesestand, Verwalter, Ersteller, Einladungen, Verlauf
 * (Verfasser, Reaktionen, Löschungen, Systemzeilen) und Anhänge gehen auf den neuen Namen über – eigene Nachrichten bleiben
 * bearbeitbar. Die Kennung einer DM hängt an beiden Namen: offene DMs ziehen an die neue Kennung um, sonst öffnete
 * „Nachricht schreiben“ eine leere zweite DM. Wirft nie. → {umzug: {alteId: neueId}} für die Stumm-Listen in users.json.
 */
export async function nutzerImChatUmbenennen(w, alt, neu) {
  const umzug = {};
  let raeume = [];
  try { raeume = await alleRaeume(w); } catch (e) { process.stderr.write(`[chat] Umbenennen ${alt}: ${e.message}\n`); return { umzug }; }
  const tausch = (x) => (x === alt ? neu : x);
  const dms = [];
  for (const r of raeume) {
    try {
      await umschreiben(w, r.id, (z) => (z && (z.von === alt || z.wer === alt) ? { ...z, ...(z.von === alt ? { von: neu } : {}), ...(z.wer === alt ? { wer: neu } : {}) } : z));
      await anhaengeUmbenennen(w, r.id, alt, neu);
      const betroffen = istMitglied(r, alt) || r.ersteller === alt || (r.verwalter || []).includes(alt) || (r.letzte && r.letzte.von === alt)
        || (r.einladungen || []).some((e) => e && e.von === alt);
      if (!betroffen) continue;
      const x = await raumAendern(w, r.id, (d) => {
        if (!d) return UNVERAENDERT;
        const n = { ...d, verwalter: (d.verwalter || []).map(tausch) };
        if (istMitglied(d, alt)) n.mitglieder = Object.fromEntries(Object.entries(d.mitglieder).map(([k, v]) => [tausch(k), v]));
        if (d.ersteller === alt) n.ersteller = neu;
        if (Array.isArray(d.einladungen)) n.einladungen = d.einladungen.map((e) => (e && e.von === alt ? { ...e, von: neu } : e));
        if (d.letzte && d.letzte.von === alt) n.letzte = { ...d.letzte, von: neu };
        return n;
      });
      if (x && x.art === 'dm' && !x.geschlossen && istMitglied(x, neu)) dms.push(x);
      else if (x) chatEreignis(w, x, 'raum', kurzform(x));
    } catch (e) {
      process.stderr.write(`[chat] Umbenennen ${alt} in Raum ${r.id}: ${e.message}\n`);
    }
  }
  for (const r of dms) {
    try {
      const partner = Object.keys(r.mitglieder).find((k) => k !== neu);
      if (!partner) continue;
      let ziel = null;
      for (let folge = 0; folge < 100 && !ziel; folge++) {
        const id = dmId(neu, partner, folge);
        if (id === r.id) break; // passt schon
        if (!(await raumLaden(w, id)) && !(await fs.lstat(raumOrdner(w, id)).then(() => true, () => false))) ziel = id;
      }
      if (!ziel) { chatEreignis(w, r, 'raum', kurzform(r)); continue; }
      await dmUmziehen(w, r, ziel);
      umzug[r.id] = ziel;
    } catch (e) {
      process.stderr.write(`[chat] DM ${r.id} umziehen: ${e.message}\n`);
    }
  }
  return { umzug };
}
