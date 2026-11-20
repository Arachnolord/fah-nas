// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Office-Aktionen (Plan 04, V14): Dokumente anlegen, laden, speichern, importieren, umbenennen; Startseiten-Liste;
// Office-Freigaben je Nutzer. Inhalte liegen als Bündel in den Freigaben und werden immer über den Dateihelfer als
// Aufrufer bzw. – über eine Office-Freigabe – als Besitzer gelesen und geschrieben. Inhalte kommen nie ins
// Prüfprotokoll (V1); Änderungen gehen als Agent-Ereignis `office` an den Web-Dienst (nie über SSE, V7).

import path from 'node:path';
import { FahnasFehler } from '../../gemeinsam/fehler.js';
import { R } from '../../gemeinsam/schema.js';
import { UNVERAENDERT } from '../../gemeinsam/konfig.js';
import { pruefeDateiname } from '../../gemeinsam/pfade.js';
import { OFFICE_ARTEN, ENDUNGEN, INHALT_DATEI, DATEIEN_ORDNER, DATEI_MAX_BYTES, DATEI_MUSTER, artAusName } from '../../gemeinsam/office.js';
import { freigabeHolen, freigabeRechte, pfadVorpruefen, helfer, idsFuer, freierPlatz } from './dateien.js';
import { mimeVon } from '../helfer/dateihelfer.js';
import { kopierenAls } from '../helfer/kopieren_als.js';
import { S_ID, neueOfficeId, neueDateiId, inhaltBauen, schnappschuesseAn } from '../office/buendel.js';
import { indexLaden, indexAendern, eintragAmOrt, zuletztMerken, eigen } from '../office/index.js';
import { officeZugriff, rechtErmitteln, rechtAus, staerker } from '../office/zugriff.js';
import { faelligFuer, faelligVergessen, msBisAcht, morgenlauf } from '../office/faellig.js';
import { umbenennungenLaden, namenErsetzen } from '../helfer/umbenennungen.js';

/** Dokumentname: 1–200 Zeichen ohne „/“, „\“ und Steuerzeichen, nicht mit „.“ beginnend. */
const S_NAME = { typ: 'string', pflicht: true, min: 1, max: 200, muster: /^(?!\.)[^/\\\u0000-\u001f\u007f]+$/, hinweis: 'Name: 1–200 Zeichen ohne / und \\, nicht mit Punkt beginnend' };
const S_ORT = { id: { ...S_ID, pflicht: false }, freigabe: { ...R.freigabename, pflicht: false }, pfad: { typ: 'string', max: 4096 } };
const ISO_ZEIT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

const jetztIso = (w) => new Date(typeof w.jetzt === 'function' ? w.jetzt() : Date.now()).toISOString();
const verschoben = () => new FahnasFehler('E_NICHT_GEFUNDEN', 'Das Dokument liegt nicht mehr an seinem Ort', { office: 'verschoben' });
const zuGross = () => new FahnasFehler('E_PARAMS', 'Die Datei ist größer als 100 MiB', { feld: 'groesse', max: DATEI_MAX_BYTES });

/** Name einer Datei im Bündel: „<12 Zeichen>-<Originalname>“ (wirft E_PARAMS mit feld name). */
function dateiImBuendel(name) {
  pruefeDateiname(name, 'name');
  const datei = `${neueDateiId()}-${name}`;
  if (!DATEI_MUSTER.test(datei)) throw new FahnasFehler('E_PARAMS', 'Name enthält unerlaubte Zeichen', { feld: 'name' });
  return datei;
}

/** Helfer-Aufruf auf ein bekanntes Bündel: fehlt es, ist das Dokument verschoben (SMB) oder weg. */
async function amOrt(arbeit) {
  try { return await arbeit(); } catch (f) {
    if (f instanceof FahnasFehler && f.code === 'E_NICHT_GEFUNDEN') throw verschoben();
    throw f;
  }
}

/** Name ohne Endung aus dem Bündelnamen („Neu/Q4.fahboard“ → „Q4“). */
function nameAusPfad(rel) {
  const datei = path.posix.basename(rel);
  const art = artAusName(datei);
  return art ? datei.slice(0, -ENDUNGEN[art].length) : datei;
}

/** Andere (nicht gelöschte) Einträge an genau diesem Ort gehören zu einem verschwundenen Bündel: als gelöscht markieren. */
function ortFreimachen(ix, freigabe, pfad, ausser, zeit) {
  const weg = [];
  for (const d of Object.values(ix.dokumente)) {
    if (d && d.id !== ausser && !d.geloescht && d.freigabe === freigabe && d.pfad === pfad) { d.geloescht = zeit; weg.push(d.id); }
  }
  return weg;
}

/** Gibt es den Ort eines Eintrags noch? Geprüft als Besitzer; im Zweifel „ja“ (dann wird eine Kopie angelegt). */
async function ortBesteht(w, d) {
  const users = await w.konfig.laden('users.json');
  const b = (users?.nutzer || []).find((n) => n.name === d.besitzer && !n.gesperrt);
  if (!b) return true;
  const als = { nutzer: b.name, rolle: b.rolle, ip: '-' };
  try {
    const r = await freigabeRechte(w, d.freigabe, als);
    await helfer(w, als, 'info', { wurzel: r.wurzel, pfad: `${d.pfad}/${INHALT_DATEI}` });
    return true;
  } catch (f) {
    return !(f instanceof FahnasFehler && f.code === 'E_NICHT_GEFUNDEN');
  }
}

/**
 * Bündel ohne Index-Eintrag am Ort aufnehmen: unbekannte gültige ID übernehmen (Besitzer aus inhalt.json, wenn aktiv);
 * ID an anderem Ort, der fehlt → Eintrag zieht um (Freigaben bleiben); Ort noch da → Kopie mit neuer ID; sonst neue ID.
 * Die Datei selbst bleibt unverändert – office.speichern schreibt später die ID aus dem Index. Rückgabe: die ID.
 */
async function eintragAufnehmen(w, k, freigabe, rel, inhalt) {
  const zeit = jetztIso(w);
  const art = artAusName(path.posix.basename(rel));
  const name = nameAusPfad(rel);
  const iid = typeof inhalt?.id === 'string' && S_ID.muster.test(inhalt.id) ? inhalt.id : null;
  const vorhanden = iid ? (await indexLaden(w)).dokumente[iid] : null;
  const umziehen = !!vorhanden && ((vorhanden.freigabe === freigabe && vorhanden.pfad === rel) || !(await ortBesteht(w, vorhanden)));
  const users = await w.konfig.laden('users.json');
  const aktiv = (n) => (users?.nutzer || []).some((x) => x.name === n && !x.gesperrt);
  const zeitAus = (z) => (typeof z === 'string' && ISO_ZEIT.test(z) ? z : zeit);
  let id;
  await indexAendern(w, (ix) => {
    const da = eintragAmOrt(ix, freigabe, rel);
    if (da) { id = da.id; return UNVERAENDERT; } // gleichzeitig schon aufgenommen
    if (umziehen && ix.dokumente[iid]) {
      const d = ix.dokumente[iid];
      Object.assign(d, { freigabe, pfad: rel, name }); delete d.geloescht;
      id = iid; return ix;
    }
    const uebernehmen = iid && !ix.dokumente[iid];
    id = uebernehmen ? iid : neueOfficeId();
    const besitzer = uebernehmen && aktiv(inhalt.besitzer) ? inhalt.besitzer : k.nutzer;
    ix.dokumente[id] = { id, art, name, freigabe, pfad: rel, besitzer, erstellt: uebernehmen ? zeitAus(inhalt.erstellt) : zeit, geaendert: zeitAus(inhalt.geaendert), freigaben: {} };
    return ix;
  });
  return id;
}

async function zuletztEintragen(w, nutzer, id) {
  const zeit = jetztIso(w);
  await indexAendern(w, (ix) => { if (!ix.dokumente[id]) return UNVERAENDERT; zuletztMerken(ix, nutzer, id, zeit); return ix; });
}

async function geaendertSetzen(w, id, zeit) {
  await indexAendern(w, (ix) => { const d = ix.dokumente[id]; if (!d) return UNVERAENDERT; d.geaendert = zeit; return ix; });
}

/** Recht-Rechner für Listen: Fehler (z. B. gelöschte Freigabe) heißen „kein Recht“; je Freigabe/Kontext nur einmal gerechnet. */
function rechtMerker(w) {
  const merk = new Map();
  return (freigabe, k) => {
    const s = `${freigabe}\u0000${k.nutzer}\u0000${k.rolle}`;
    if (!merk.has(s)) merk.set(s, freigabeRechte(w, freigabe, k).then(rechtAus, () => null));
    return merk.get(s);
  };
}

/** Wer außer dem Besitzer kommt an das Dokument? Über die Freigabe (ohne Admins, ohne Gesperrte) oder per Office-Freigabe. */
async function geteiltMit(w, eintrag) {
  const users = await w.konfig.laden('users.json');
  const rechtVon = rechtMerker(w);
  const besitzer = (users?.nutzer || []).find((n) => n.name === eintrag.besitzer && !n.gesperrt);
  const besitzerRecht = besitzer ? await rechtVon(eintrag.freigabe, { nutzer: besitzer.name, rolle: besitzer.rolle }) : null;
  const aus = [];
  for (const n of users?.nutzer || []) {
    if (n.gesperrt || n.name === eintrag.besitzer) continue;
    let recht = await rechtVon(eintrag.freigabe, { nutzer: n.name, rolle: 'nutzer' });
    let ueber = 'freigabe';
    let ro = eigen(eintrag.freigaben, n.name) ?? null;
    if (!besitzerRecht) ro = null;
    else if (ro === 'bearbeiten' && besitzerRecht !== 'bearbeiten') ro = 'lesen';
    if (n.rolle === 'admin') { recht = ro; ueber = 'office'; } // Admins zählen nur mit ausdrücklicher Office-Freigabe
    else if (staerker(ro, recht)) { recht = ro; ueber = 'office'; }
    if (recht) aus.push({ name: n.name, anzeigename: n.anzeigename || n.name, recht, ueber });
  }
  return aus.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export function registriere(reg, w) {
  reg.aktion('office.anlegen', {
    rolle: 'nutzer', beschreibung: 'Neues Office-Dokument in einer Freigabe anlegen',
    schema: { art: { typ: 'string', pflicht: true, werte: OFFICE_ARTEN }, freigabe: R.freigabename, ordner: R.pfad, name: S_NAME, beide: { typ: 'boolean', standard: false } },
    audit: (p) => ({ art: p.art, freigabe: p.freigabe, ordner: p.ordner, name: p.name }),
    ausfuehren: async (p, k) => {
      const r = await freigabeHolen(w, p.freigabe, k, true);
      const { rel: ordner } = await pfadVorpruefen(r.wurzel, p.ordner, 'ordner');
      const id = neueOfficeId();
      const zeit = jetztIso(w);
      const endung = ENDUNGEN[p.art];
      const inhalt = inhaltBauen({ id, art: p.art, besitzer: k.nutzer, erstellt: zeit }, { version: 0, daten: null, geaendert: zeit });
      const h = await helfer(w, k, 'office_anlegen', { wurzel: r.wurzel, rel_ordner: ordner, name: p.name, endung, inhalt, beide: p.beide });
      const name = h.name.slice(0, -endung.length);
      let weg = [];
      await indexAendern(w, (ix) => {
        weg = ortFreimachen(ix, p.freigabe, h.pfad, id, zeit);
        ix.dokumente[id] = { id, art: p.art, name, freigabe: p.freigabe, pfad: h.pfad, besitzer: k.nutzer, erstellt: zeit, geaendert: zeit, freigaben: {} };
        zuletztMerken(ix, k.nutzer, id, zeit);
        return ix;
      });
      for (const alt of weg) w.ereignis('office', { art: 'geloescht', id: alt });
      return { id, art: p.art, freigabe: p.freigabe, pfad: h.pfad, name };
    },
  });

  reg.aktion('office.import_setzen', {
    rolle: 'nutzer', beschreibung: 'Importierte Daten in ein neues, leeres Office-Dokument übernehmen',
    schema: { id: S_ID, daten: { typ: 'object', pflicht: true } },
    audit: (p) => ({ id: p.id }),
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k, { schreiben: true });
      const g = await amOrt(() => helfer(w, z.als, 'office_lesen', { wurzel: z.wurzel, rel: z.rel }));
      if (g.inhalt.version !== 0) throw new FahnasFehler('E_PARAMS', 'Nur ein neues, leeres Dokument kann einen Import aufnehmen', { feld: 'id' });
      const zeit = jetztIso(w);
      const inhalt = inhaltBauen(z.eintrag, { version: 1, daten: p.daten, geaendert: zeit });
      const r = await amOrt(() => helfer(w, z.als, 'office_schreiben', { wurzel: z.wurzel, rel: z.rel, inhalt, stand_vorher: g.stand }));
      await geaendertSetzen(w, p.id, zeit);
      if (z.eintrag.art === 'board') faelligVergessen();
      return { version: 1, stand: r.stand };
    },
  });

  reg.aktion('office.laden', {
    rolle: 'nutzer', audit: false, beschreibung: 'Office-Dokument laden (über ID oder Ort)',
    schema: S_ORT,
    ausfuehren: async (p, k) => {
      let z = await officeZugriff(w, { id: p.id, freigabe: p.freigabe, pfad: p.pfad }, k);
      let g;
      if (z.eintrag) {
        g = p.id ? await amOrt(() => helfer(w, z.als, 'office_lesen', { wurzel: z.wurzel, rel: z.rel, mit_verlauf: true }))
          : await helfer(w, z.als, 'office_lesen', { wurzel: z.wurzel, rel: z.rel, mit_verlauf: true });
      } else {
        g = await helfer(w, k, 'office_lesen', { wurzel: z.wurzel, rel: z.rel, mit_verlauf: true });
        g = { ...g, inhalt: namenErsetzen(g.inhalt, await umbenennungenLaden(w)) };
        z = await officeZugriff(w, { id: await eintragAufnehmen(w, k, p.freigabe, z.rel, g.inhalt) }, k);
      }
      // umbenannte Nutzer: Kommentare/Karten tragen noch den alten Namen – beim Laden übersetzen (Tabellen haben keine)
      const umbenannt = z.eintrag.art === 'tabelle' ? null : await umbenennungenLaden(w);
      await zuletztEintragen(w, k.nutzer, z.eintrag.id);
      const d = z.eintrag;
      return {
        id: d.id, art: d.art, name: d.name, freigabe: d.freigabe, pfad: d.pfad, besitzer: d.besitzer, recht: z.recht,
        version: Number.isInteger(g.inhalt.version) ? g.inhalt.version : 0, daten: namenErsetzen(g.inhalt.daten ?? null, umbenannt), stand: g.stand,
        verlauf: namenErsetzen(g.verlauf || [], umbenannt), schnappschuesse: await schnappschuesseAn(w, d.freigabe),
      };
    },
  });

  reg.aktion('office.speichern', {
    rolle: 'nutzer', beschreibung: 'Office-Dokument speichern (mit Stand-Prüfung)',
    schema: {
      id: S_ID, version: { typ: 'integer', pflicht: true, min: 0 }, daten: { typ: 'object', pflicht: true },
      ops: { typ: 'array', max: 5000, standard: [], elemente: { typ: 'object', felder: { v: { typ: 'integer', pflicht: true, min: 1 }, op: { typ: 'object', pflicht: true }, cid: { typ: 'string', max: 64 } } } },
      stand: { typ: 'string', max: 40 },
    },
    audit: (p) => ({ id: p.id, version: p.version }),
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k, { schreiben: true });
      const zeit = jetztIso(w);
      const inhalt = inhaltBauen(z.eintrag, { version: p.version, daten: p.daten, geaendert: zeit });
      const verlauf = p.ops.map((o) => (o.cid ? { v: o.v, op: o.op, cid: o.cid } : { v: o.v, op: o.op }));
      const r = await amOrt(() => helfer(w, z.als, 'office_schreiben', { wurzel: z.wurzel, rel: z.rel, inhalt, stand_vorher: p.stand || null, verlauf }));
      await geaendertSetzen(w, p.id, zeit);
      if (z.eintrag.art === 'board') faelligVergessen();
      return { stand: r.stand };
    },
  });

  reg.aktion('office.recht', {
    rolle: 'nutzer', lesend: true, audit: false, beschreibung: 'Recht und Stand eines offenen Office-Dokuments prüfen',
    schema: { ...S_ORT, merken: { typ: 'boolean', standard: false } },
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id, freigabe: p.freigabe, pfad: p.pfad }, k);
      if (!z.eintrag) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Dokument gibt es nicht');
      const info = await amOrt(() => helfer(w, z.als, 'info', { wurzel: z.wurzel, pfad: `${z.rel}/${INHALT_DATEI}` }));
      if (p.merken) await zuletztEintragen(w, k.nutzer, z.eintrag.id);
      return { id: z.eintrag.id, recht: z.recht, stand: info.geaendert };
    },
  });

  reg.aktion('office.umbenennen', {
    rolle: 'nutzer', beschreibung: 'Office-Dokument umbenennen',
    schema: { id: S_ID, name: S_NAME },
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k, { schreiben: true });
      const neuerName = `${p.name}${ENDUNGEN[z.eintrag.art]}`;
      if (path.posix.basename(z.rel) === neuerName) return { id: p.id, name: p.name, pfad: z.rel };
      const r = await amOrt(() => helfer(w, z.als, 'umbenennen', { wurzel: z.wurzel, pfad: z.rel, neuer_name: neuerName }));
      const zeit = jetztIso(w);
      let weg = [];
      await indexAendern(w, (ix) => {
        weg = ortFreimachen(ix, z.eintrag.freigabe, r.pfad, p.id, zeit);
        const d = ix.dokumente[p.id];
        if (d) Object.assign(d, { pfad: r.pfad, name: p.name });
        return ix;
      });
      for (const alt of weg) w.ereignis('office', { art: 'geloescht', id: alt });
      w.ereignis('office', { art: 'pfad', id: p.id, freigabe: z.eintrag.freigabe, pfad: r.pfad, name: p.name });
      return { id: p.id, name: p.name, pfad: r.pfad };
    },
  });

  reg.aktion('office.datei_ticket', {
    rolle: 'nutzer', beschreibung: 'Bild oder Anhang in ein Office-Dokument hochladen (Datenkanal-Ticket)',
    schema: { id: S_ID, name: { typ: 'string', pflicht: true, max: 200 }, groesse: { typ: 'integer', pflicht: true, min: 0 } },
    ausfuehren: async (p, k) => {
      if (p.groesse > DATEI_MAX_BYTES) throw zuGross();
      const datei = dateiImBuendel(p.name);
      const z = await officeZugriff(w, { id: p.id }, k, { schreiben: true });
      const rel = `${z.rel}/${DATEIEN_ORDNER}/${datei}`;
      const ziel = await amOrt(() => helfer(w, z.als, 'pruefe_schreiben', { wurzel: z.wurzel, pfad: rel, bei_vorhanden: 'fehler' }));
      const { freigabe } = await freigabeRechte(w, z.eintrag.freigabe, z.als);
      const frei = await freierPlatz(w.system, z.wurzel, freigabe);
      if (frei !== null && p.groesse > frei) throw new FahnasFehler('E_PLATZ', 'Nicht genug freier Platz in der Freigabe', { noetig: p.groesse, frei });
      const ids = await idsFuer(w, z.als, z.wurzel);
      // Der Datenkanal schreibt in die Zwischendatei; erst danach legt der Helfer sie als z.als ab (oder verwirft sie).
      const abschluss = async (erfolg) => {
        if (!erfolg) return helfer(w, z.als, 'upload_verwerfen', { wurzel: z.wurzel, pfad: rel, tmp: ziel.tmp });
        await helfer(w, z.als, 'upload_abschliessen', { wurzel: z.wurzel, pfad: rel, tmp: ziel.tmp, bei_vorhanden: 'fehler', papierkorb: false, nutzer: z.als.nutzer }, { zeitlimit_ms: 0 });
        return { datei, name: p.name };
      };
      return w.datenkanal.ticket({ nutzer: k.nutzer, uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen, art: 'schreiben', pfad: ziel.tmp, dateiname: p.name, groesse: p.groesse, mime: mimeVon(p.name), abschluss });
    },
  });

  reg.aktion('office.datei_lesen', {
    rolle: 'nutzer', lesend: true, beschreibung: 'Bild oder Anhang eines Office-Dokuments lesen (Datenkanal-Ticket)',
    schema: { id: S_ID, datei: { typ: 'string', pflicht: true, max: 220, muster: DATEI_MUSTER, hinweis: 'Datei ungültig' } },
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k);
      const rel = `${z.rel}/${DATEIEN_ORDNER}/${p.datei}`;
      const { abs } = await pfadVorpruefen(z.wurzel, rel, 'datei');
      const info = await helfer(w, z.als, 'info', { wurzel: z.wurzel, pfad: rel });
      if (info.art !== 'datei') throw new FahnasFehler('E_PARAMS', 'Das ist keine Datei', { feld: 'datei' });
      const ids = await idsFuer(w, z.als, z.wurzel);
      return w.datenkanal.ticket({ nutzer: k.nutzer, uid: ids.uid, gid: ids.gid, gruppen: ids.gruppen, art: 'lesen', pfad: abs, dateiname: p.datei.slice(13), groesse: info.groesse, mime: mimeVon(p.datei) });
    },
  });

  reg.aktion('office.datei_kopieren', {
    rolle: 'nutzer', beschreibung: 'Datei aus dem NAS als Anhang in ein Office-Dokument kopieren',
    schema: { id: S_ID, freigabe: R.freigabename, pfad: { typ: 'string', pflicht: true, max: 4096 } },
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k, { schreiben: true });
      const q = await freigabeHolen(w, p.freigabe, k);
      const { rel, abs: quelleAbs } = await pfadVorpruefen(q.wurzel, p.pfad);
      const info = await helfer(w, k, 'info', { wurzel: q.wurzel, pfad: rel });
      if (info.art !== 'datei') throw new FahnasFehler('E_PARAMS', 'Kopieren lässt sich nur eine Datei', { feld: 'pfad' });
      if (info.groesse > DATEI_MAX_BYTES) throw zuGross();
      const datei = dateiImBuendel(info.name);
      // Zielordner über die Freigabe auflösen: ein Symlink im Bündel darf nicht aus der Freigabe hinausführen
      const { abs: zielOrdnerAbs } = await pfadVorpruefen(z.wurzel, `${z.rel}/${DATEIEN_ORDNER}`);
      await kopierenAls(w, { quelleAbs, quelleIds: await idsFuer(w, k, q.wurzel), zielOrdnerAbs, zielName: datei, zielKontext: z.als, beiVorhanden: 'fehler' });
      return { datei, name: info.name, groesse: info.groesse, mime: mimeVon(info.name) }; // Größe und Art braucht der Board-Anhang
    },
  });

  reg.aktion('office.liste', {
    rolle: 'nutzer', lesend: true, schema: {}, beschreibung: 'Office-Startseite: zuletzt geöffnet, eigene und geteilte Dokumente',
    ausfuehren: async (_p, k) => {
      const ix = await indexLaden(w);
      const users = await w.konfig.laden('users.json');
      const namen = new Map((users?.nutzer || []).map((n) => [n.name, n]));
      const rechtVon = rechtMerker(w);
      const besitzerVon = async (n) => namen.get(n) || null;
      const alsNutzer = k.rolle === 'admin' ? { ...k, rolle: 'nutzer' } : k; // Liste ohne Admin-Sonderrecht
      const ansicht = async (d, kontext) => {
        const { recht } = await rechtErmitteln(d, kontext, { rechtVon, besitzerVon });
        if (!recht) return null;
        return {
          id: d.id, art: d.art, name: d.name, freigabe: d.freigabe, pfad: d.pfad, besitzer: d.besitzer,
          besitzer_name: namen.get(d.besitzer)?.anzeigename || d.besitzer, geaendert: d.geaendert, recht, geteilt: Object.keys(d.freigaben || {}).length > 0,
        };
      };
      const alle = async (liste, kontext) => (await Promise.all(liste.map((d) => ansicht(d, kontext)))).filter(Boolean);
      const neuesteZuerst = (a, b) => String(b.geaendert).localeCompare(String(a.geaendert));
      const aktiv = Object.values(ix.dokumente).filter((d) => d && !d.geloescht);
      const eigeneZuletzt = eigen(ix.zuletzt, k.nutzer);
      const zuletzt = (Array.isArray(eigeneZuletzt) ? eigeneZuletzt : []).map((z) => eigen(ix.dokumente, z && z.id)).filter((d) => d && !d.geloescht);
      return {
        zuletzt: await alle(zuletzt, k), // selbst Geöffnetes bleibt – auch für Admins
        meine: (await alle(aktiv.filter((d) => d.besitzer === k.nutzer), alsNutzer)).sort(neuesteZuerst),
        fuer_mich: (await alle(aktiv.filter((d) => d.besitzer !== k.nutzer && eigen(d.freigaben, k.nutzer)), alsNutzer)).sort(neuesteZuerst),
      };
    },
  });

  reg.aktion('office.freigaben', {
    rolle: 'nutzer', lesend: true, schema: { id: S_ID }, beschreibung: 'Wer ein Office-Dokument sehen oder bearbeiten kann',
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k);
      const geteilt = await geteiltMit(w, z.eintrag);
      return { besitzer: z.eintrag.besitzer, freigaben: { ...(z.eintrag.freigaben || {}) }, geteilt_mit: geteilt, privat: geteilt.length === 0 };
    },
  });

  reg.aktion('office.freigeben', {
    rolle: 'nutzer', beschreibung: 'Office-Dokument für einen Nutzer freigeben oder die Freigabe entziehen',
    schema: { id: S_ID, nutzer: R.nutzername, recht: { typ: 'string', pflicht: true, werte: ['lesen', 'bearbeiten', 'keins'] } },
    ausfuehren: async (p, k) => {
      const z = await officeZugriff(w, { id: p.id }, k);
      if (z.eintrag.besitzer !== k.nutzer) throw new FahnasFehler('E_RECHTE', 'Freigeben darf nur, wem das Dokument gehört');
      const users = await w.konfig.laden('users.json');
      const bekannt = (users?.nutzer || []).some((n) => n.name === p.nutzer);
      const hatte = Object.hasOwn(z.eintrag.freigaben || {}, p.nutzer);
      if (p.nutzer === z.eintrag.besitzer || (!bekannt && !(p.recht === 'keins' && hatte))) {
        throw new FahnasFehler('E_PARAMS', `„${p.nutzer}“ kann hier nicht freigegeben werden`, { feld: 'nutzer' });
      }
      let freigaben = {};
      await indexAendern(w, (ix) => {
        const d = ix.dokumente[p.id];
        if (!d) throw new FahnasFehler('E_NICHT_GEFUNDEN', 'Dieses Dokument gibt es nicht');
        d.freigaben ??= {};
        if (p.recht === 'keins') delete d.freigaben[p.nutzer]; else d.freigaben[p.nutzer] = p.recht;
        freigaben = { ...d.freigaben };
        return ix;
      });
      faelligVergessen();
      w.ereignis('office', { art: 'rechte', id: p.id });
      return { freigaben };
    },
  });

  reg.aktion('office.faellig', {
    rolle: 'nutzer', lesend: true, schema: {}, beschreibung: 'Heute und früher fällige Board-Karten, für die ich zuständig bin',
    ausfuehren: async (_p, k) => faelligFuer(w, k),
  });

  reg.aktion('office.personen', {
    rolle: 'nutzer', lesend: true, schema: {}, beschreibung: 'NAS-Nutzer zum Freigeben (ohne gesperrte und ohne mich)',
    ausfuehren: async (_p, k) => {
      const users = await w.konfig.laden('users.json');
      return (users?.nutzer || []).filter((n) => !n.gesperrt && n.name !== k.nutzer)
        .map((n) => ({ name: n.name, anzeigename: n.anzeigename || n.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de'));
    },
  });
}

// Morgen-Meldung täglich um 08:00 Ortszeit
let morgenZeitgeber = null; let morgenAktiv = false;

export async function starten(w) {
  morgenAktiv = true;
  const planen = () => {
    if (!morgenAktiv) return;
    morgenZeitgeber = setTimeout(async () => {
      try { await morgenlauf(w); } catch (f) { process.stderr.write(`[office] Morgen-Meldung: ${f && f.message}\n`); }
      planen();
    }, msBisAcht(new Date()));
    morgenZeitgeber.unref?.();
  };
  planen();
}

export async function stoppen() {
  morgenAktiv = false;
  if (morgenZeitgeber) clearTimeout(morgenZeitgeber);
  morgenZeitgeber = null;
}
