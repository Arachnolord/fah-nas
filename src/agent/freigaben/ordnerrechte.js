// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ordnerrechte (Betreiber 19.10.2026): einzelne Ordner einer Freigabe für Nutzer oder Gruppen sperren („kein Zugriff“)
// oder auf „nur lesen“ setzen – für den Ordner und alles darunter. Reine Regeln ohne Systemzugriff: wer ist wo wie
// eingeschränkt, und welche Soll-ACL bekommt ein Bereich auf der Platte. Den Abgleich mit der Platte macht
// ordnerrechte-abgleich.js. Wahrheit: shares.json → freigaben[].ordnerrechte = [{pfad, regeln: {konto: stufe}}].
//
// Grundsätze: Regeln schränken nur ein (nie mehr als die Freigabe gibt), das Strengste aus allen Regeln am Ordner und
// darüber gilt, eine Gruppenregel trifft jedes Mitglied (auch wenn es die Freigabe zusätzlich persönlich hat), Admins
// sind nie eingeschränkt.

import { FahnasFehler } from '../../gemeinsam/fehler.js';

/** Einschränkungen, vom milderen zum strengeren. Ohne Eintrag gilt „wie Freigabe“. */
export const STUFEN = Object.freeze(['lesen', 'keiner']);
const RANG = Object.freeze({ lesen: 1, keiner: 2 });
export const MAX_REGELN = 200;      // Ordner mit Regeln je Freigabe
export const MAX_KONTEN = 200;      // Einträge je Ordner

/** Die strengere von zwei Stufen (undefined/null = keine Einschränkung). */
export function strenger(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return RANG[b] > RANG[a] ? b : a;
}

/** Gruppen eines Nutzers aus users.json: sowohl `nutzer[].gruppen` als auch `gruppen[].mitglieder` zählen. */
export function gruppenVon(users, name) {
  const aus = new Set();
  const n = (users?.nutzer || []).find((x) => x.name === name);
  for (const g of n?.gruppen || []) aus.add(String(g).replace(/^@/, ''));
  for (const g of users?.gruppen || []) if (Array.isArray(g.mitglieder) && g.mitglieder.includes(name)) aus.add(g.name);
  return aus;
}

function istAdmin(users, name) { return (users?.nutzer || []).some((n) => n.name === name && n.rolle === 'admin'); }

/** Liegt `rel` im Bereich `zone` (gleich oder darunter)? Beide relativ zur Freigabe, ohne führenden „/“. */
export function unter(rel, zone) { return rel === zone || String(rel).startsWith(`${zone}/`); }

/** Recht eines (Nicht-Admin-)Nutzers an der ganzen Freigabe: 'schreiben' | 'lesen' | null. Gäste-Freigabe = lesen. */
export function freigabeRecht(f, users, name) {
  const gruppen = gruppenVon(users, name);
  const drin = (liste) => (Array.isArray(liste) ? liste : []).some((e) => e === name || (typeof e === 'string' && e.startsWith('@') && gruppen.has(e.slice(1))));
  if (drin(f.schreiben)) return 'schreiben';
  if (drin(f.lesen) || f.gaeste === true) return 'lesen';
  return null;
}

/** Regeln einer Freigabe in fester Form: [{pfad, regeln:{konto:stufe}}], nach Pfad sortiert, leere fallen weg. */
export function regelnNormieren(liste) {
  const aus = [];
  for (const r of Array.isArray(liste) ? liste : []) {
    if (!r || typeof r.pfad !== 'string' || !r.pfad || !r.regeln || typeof r.regeln !== 'object') continue;
    const regeln = {};
    for (const [konto, stufe] of Object.entries(r.regeln)) if (STUFEN.includes(stufe)) regeln[konto] = stufe;
    if (Object.keys(regeln).length) aus.push({ pfad: r.pfad, regeln });
  }
  return aus.sort((a, b) => (a.pfad < b.pfad ? -1 : a.pfad > b.pfad ? 1 : 0));
}

/** Alle Regeln, die an `rel` greifen (am Ordner selbst und an allen Ordnern darüber). */
function greifend(f, rel) { return regelnNormieren(f.ordnerrechte).filter((r) => unter(rel, r.pfad)); }

/** Wirksame Einschränkung eines Nutzers an `rel`: 'keiner' | 'lesen' | null. Admins: immer null. */
export function einschraenkung(f, users, name, rel) {
  if (istAdmin(users, name)) return null;
  const gruppen = gruppenVon(users, name);
  let stufe = null;
  for (const r of greifend(f, rel)) {
    for (const [konto, s] of Object.entries(r.regeln)) {
      if (konto === name || (konto.startsWith('@') && gruppen.has(konto.slice(1)))) stufe = strenger(stufe, s);
    }
  }
  return stufe;
}

/** Bereiche, in denen der Nutzer eingeschränkt ist: [{pfad, stufe}] (für Markierungen in der Dateiliste). */
export function bereicheFuer(f, users, name) {
  if (istAdmin(users, name)) return [];
  const aus = [];
  for (const r of regelnNormieren(f.ordnerrechte)) {
    const stufe = einschraenkung(f, users, name, r.pfad);
    if (stufe) aus.push({ pfad: r.pfad, stufe });
  }
  return aus;
}

/** Einschränkung aus einer Bereichsliste (bereicheFuer) an `rel` – ohne users.json, für die Agent-Prüfungen. */
export function stufeAn(bereiche, rel) {
  let stufe = null;
  for (const b of bereiche || []) if (unter(rel, b.pfad)) stufe = strenger(stufe, b.stufe);
  return stufe;
}

/**
 * Sperre für eine Aktion prüfen: `rel` liegt in einem Bereich mit „kein Zugriff“ → E_RECHTE (details.gesperrt); soll
 * geschrieben werden und der Bereich ist „nur lesen“ → E_RECHTE (details.nur_lesen).
 */
export function sperrePruefen(bereiche, rel, schreiben = false, feld = 'pfad') {
  const stufe = stufeAn(bereiche, rel);
  if (stufe === 'keiner') throw new FahnasFehler('E_RECHTE', 'Nicht für dich freigegeben', { feld, gesperrt: true });
  if (schreiben && stufe === 'lesen') throw new FahnasFehler('E_RECHTE', 'In diesem Ordner darfst du nur lesen', { feld, nur_lesen: true });
}

/** Strengste Stufe aller Regeln an `rel` – gilt für das Gastkonto (sonst ließe sich jede Sperre per Gast-Login umgehen). */
export function gastStufe(f, rel) {
  let stufe = null;
  for (const r of greifend(f, rel)) for (const s of Object.values(r.regeln)) stufe = strenger(stufe, s);
  return stufe;
}

/** Rechte-Text „rwx“ auf eine Stufe begrenzen: keiner → „---“, lesen → ohne „w“. */
export function begrenzen(rechte, stufe) {
  if (stufe === 'keiner') return '---';
  if (stufe === 'lesen') return `${rechte[0]}-${rechte[2]}`;
  return rechte;
}

/**
 * Prüft die Regeln für einen Ordner: Konten müssen bekannte Nicht-Admin-Nutzer oder Gruppen („@name“) sein, Stufen aus
 * STUFEN. Gibt {konto: stufe} zurück (leeres Objekt = Regel entfernen).
 */
export function regelnPruefen(regeln, nutzerdaten) {
  if (!regeln || typeof regeln !== 'object' || Array.isArray(regeln)) throw new FahnasFehler('E_PARAMS', 'Regeln fehlen', { feld: 'regeln' });
  const eintraege = Object.entries(regeln);
  if (eintraege.length > MAX_KONTEN) throw new FahnasFehler('E_PARAMS', `Höchstens ${MAX_KONTEN} Einträge je Ordner`, { feld: 'regeln' });
  const aus = {};
  for (const [konto, stufe] of eintraege) {
    if (stufe === null || stufe === '' || stufe === 'voll') continue; // „wie Freigabe“
    if (!STUFEN.includes(stufe)) throw new FahnasFehler('E_PARAMS', `Unbekannte Stufe „${stufe}“`, { feld: 'regeln', wert: konto });
    if (konto.startsWith('@')) {
      if (!(nutzerdaten.gruppen || []).some((g) => g.name === konto.slice(1))) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Gruppe „${konto.slice(1)}“ gibt es nicht`, { feld: 'regeln', wert: konto });
    } else {
      const n = (nutzerdaten.nutzer || []).find((x) => x.name === konto);
      if (!n) throw new FahnasFehler('E_NICHT_GEFUNDEN', `Nutzer „${konto}“ gibt es nicht`, { feld: 'regeln', wert: konto });
      if (n.rolle === 'admin') throw new FahnasFehler('E_PARAMS', `„${konto}“ ist Admin – Admins haben immer vollen Zugriff`, { feld: 'regeln', wert: konto });
    }
    aus[konto] = stufe;
  }
  return aus;
}

/** Regelpfade nachziehen, wenn ein Ordner umbenannt/verschoben wurde (innerhalb derselben Freigabe). */
export function regelnUmziehen(liste, von, nach) {
  let anders = false;
  const aus = regelnNormieren(liste).map((r) => {
    if (!unter(r.pfad, von)) return r;
    anders = true;
    return { ...r, pfad: nach + r.pfad.slice(von.length) };
  });
  return anders ? regelnNormieren(aus) : null;
}

/** Regeln unter gelöschten/weggezogenen Pfaden entfernen. null = nichts geändert. */
export function regelnOhne(liste, pfade) {
  const vorher = regelnNormieren(liste);
  const aus = vorher.filter((r) => !pfade.some((p) => p !== '' && unter(r.pfad, p)));
  return aus.length === vorher.length ? null : aus;
}

/** Konto (Nutzer oder „@gruppe“) aus allen Regeln einer Freigabe nehmen. null = nichts geändert. */
export function kontoOhne(liste, konto) {
  const vorher = regelnNormieren(liste);
  let anders = false;
  const aus = vorher.map((r) => {
    if (!(konto in r.regeln)) return r;
    anders = true;
    const regeln = { ...r.regeln }; delete regeln[konto];
    return { ...r, regeln };
  });
  return anders ? regelnNormieren(aus) : null;
}

/** Konto in allen Regeln einer Freigabe umbenennen (Nutzer umbenannt). null = nichts geändert. */
export function kontoUmbenannt(liste, alt, neu) {
  const vorher = regelnNormieren(liste);
  let anders = false;
  const aus = vorher.map((r) => {
    if (!Object.hasOwn(r.regeln, alt)) return r;
    anders = true;
    const regeln = {};
    for (const [k, v] of Object.entries(r.regeln)) regeln[k === alt ? neu : k] = v;
    return { ...r, regeln };
  });
  return anders ? regelnNormieren(aus) : null;
}

/**
 * Soll-ACL eines Bereichs (setfacl-Zeilen). `basis` = Zugriffszeilen der Freigabe (aclZeilen ohne „default:“).
 * Für jeden eingeschränkten Nicht-Admin-Nutzer entsteht ein eigener `user:`-Eintrag (POSIX wertet benannte Nutzer vor
 * allen Gruppen aus – nur so greift „@work: kein Zugriff“ auch bei Mitgliedern mit persönlichem Recht); Gruppeneinträge
 * werden begrenzt, das Gastkonto bekommt die strengste Stufe. Admins bleiben über ihre Gruppe voll.
 * → {ordner, datei, dateiX} (je die vollständige Zeilenliste) und `eingeschraenkt` (Namen – deren Einträge gehen an root).
 */
export function bereichAcl(basis, f, nutzerdaten, rel, { gastkonto = 'nobody' } = {}) {
  const eintraege = new Map(); // "user:x" | "group:g" → rwx
  for (const z of basis) {
    const m = /^(user|group):([^:]+):([rwx-]{3})$/.exec(z);
    if (m) eintraege.set(`${m[1]}:${m[2]}`, m[3]);
  }
  const regeln = greifend(f, rel);
  const stufeVon = new Map();
  for (const r of regeln) for (const [konto, s] of Object.entries(r.regeln)) stufeVon.set(konto, strenger(stufeVon.get(konto), s));
  for (const [konto, s] of stufeVon) {
    if (!konto.startsWith('@')) continue;
    const k = `group:${konto.slice(1)}`;
    if (eintraege.has(k)) eintraege.set(k, begrenzen(eintraege.get(k), s));
  }
  const eingeschraenkt = new Set();
  for (const n of nutzerdaten.nutzer || []) {
    if (n.rolle === 'admin') continue;
    let s = stufeVon.get(n.name) || null;
    for (const g of gruppenVon(nutzerdaten, n.name)) s = strenger(s, stufeVon.get(`@${g}`));
    if (!s) continue;
    const recht = freigabeRecht(f, nutzerdaten, n.name);
    eintraege.set(`user:${n.name}`, begrenzen(recht === 'schreiben' ? 'rwx' : recht === 'lesen' ? 'r-x' : '---', s));
    eingeschraenkt.add(n.name);
  }
  const gs = gastStufe(f, rel);
  if (gs && eintraege.has(`user:${gastkonto}`)) eintraege.set(`user:${gastkonto}`, begrenzen(eintraege.get(`user:${gastkonto}`), gs));

  const benannt = [...eintraege.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, r]) => `${k}:${r}`);
  const zugriff = ['user::rwx', 'group::---', 'other::---', 'mask::rwx', ...benannt];
  // Dateien: wie der Kernel sie aus der default-ACL erbt – benannte Einträge unverändert, Besitzer und Maske ohne „x“
  // (wirksam also r--/rw-). So gleicht eine neu angelegte Datei schon dem Soll und wird nie umsonst neu geschrieben.
  const ohneX = (z) => (z === 'user::rwx' ? 'user::rw-' : z === 'mask::rwx' ? 'mask::rw-' : z);
  return {
    ordner: [...zugriff, ...zugriff.map((z) => `default:${z}`)],
    datei: zugriff.map(ohneX),
    dateiX: zugriff,
    eingeschraenkt,
  };
}
