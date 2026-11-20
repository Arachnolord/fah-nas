// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ordnerrechte auf die Platte bringen (als root, Linux). Der Agent läuft mit allen Rechten, in den Ordnern schreiben aber
// Nutzer mit – wer Schreibrecht hat, könnte während des Abgleichs einen Ordner gegen eine Verknüpfung nach /etc tauschen.
// Deshalb kein Pfad-Abgleich: jeder Eintrag wird relativ zum schon geöffneten Elternordner über /proc/self/fd/<fd>/<name>
// mit O_PATH|O_NOFOLLOW geöffnet, getfacl/setfacl/chown bekommen nur /proc/<agent>/fd/<n> – das zeigt fest auf genau
// diesen Eintrag (Verknüpfungen werden nie verfolgt, Tauschen nach dem Öffnen ändert nichts).
// Geschrieben wird nur, was abweicht (sonst wüchse jeder Schnappschuss um geänderte Metadaten).

import fsp from 'node:fs/promises';
import { constants as K } from 'node:fs';

const O_PATH = 0o10000000; // Linux (x86-64/arm64): Griff ohne Lese-/Schreibzugriff, fstat/Magic-Link gehen
const STAPEL = 200;        // Einträge je getfacl/setfacl-Aufruf
const unter = (rel, name) => (rel ? `${rel}/${name}` : name);

/** getfacl -p-Ausgabe → Map Pfad → {besitzer, eintraege[]}. */
export function getfaclParsen(text) {
  const aus = new Map();
  let akt = null;
  for (const roh of String(text || '').split('\n')) {
    const z = roh.trim();
    if (!z) { akt = null; continue; }
    let m;
    if ((m = /^# file:\s*(.+)$/.exec(z))) { akt = { besitzer: '', eintraege: [] }; aus.set(m[1], akt); continue; }
    if (!akt) continue;
    if ((m = /^# owner:\s*(\S+)/.exec(z))) { akt.besitzer = m[1]; continue; }
    if (z.startsWith('#')) continue;
    akt.eintraege.push(z.replace(/\s*#effective:.*$/, ''));
  }
  return aus;
}

/** Gleiche ACL? (Reihenfolge egal) */
export function gleicheAcl(ist, soll) {
  if (!ist || ist.length !== soll.length) return false;
  const a = [...ist].sort(); const b = [...soll].sort();
  return a.every((x, i) => x === b[i]);
}

/** Soll-Zeilen für einen Eintrag nach Art: Ordner, ausführbare Datei, sonstige Datei. */
export function sollFuerArt(soll, st) {
  if (st.isDirectory()) return soll.ordner;
  return (st.mode & 0o111) ? soll.dateiX : soll.datei;
}

/**
 * Gleicht einen Bereich ab. `wurzel` = Freigabe (absolut, root-eigen), `start` = Bereich relativ dazu ('' = die ganze
 * Freigabe), `sollFuer(rel)` = Soll {ordner, datei, dateiX, eingeschraenktUids:Set} für den tiefsten Bereich über `rel`.
 * `nurWurzel`: nur den Ordner `start` selbst prüfen (schnell) – weicht er ab, wird der ganze Bereich abgeglichen.
 * `besitzKarte`: Map alte uid → neue uid oder Funktion uid → neue uid|null (Übernahme aus einem anderen NAS); Einträge
 * eingeschränkter Nutzer gehen immer an root.
 * `abgebrochen()`/`fortschritt(n)`: optional. → {fehlt, geprueft, geaendert, besitz, gruendlich}
 */
export async function bereichAbgleichen(system, { wurzel, start, sollFuer, nurWurzel = false, besitzKarte = null, abgebrochen = () => false, fortschritt = () => {} }) {
  const stat = { fehlt: false, geprueft: 0, geaendert: 0, besitz: 0, gruendlich: !nurWurzel };
  const offen = [];
  const oeffnen = async (basis, name, ordner) => {
    const fh = await fsp.open(basis === null ? name : `/proc/self/fd/${basis}/${name}`, O_PATH | K.O_NOFOLLOW | (ordner ? K.O_DIRECTORY : 0));
    offen.push(fh); return fh;
  };
  const schliessen = async (fh) => { const i = offen.indexOf(fh); if (i >= 0) offen.splice(i, 1); await fh.close().catch(() => {}); };
  const magisch = (fh) => griffPfad(fh);
  const besitzNeu = typeof besitzKarte === 'function' ? besitzKarte
    : (uid) => (besitzKarte && besitzKarte.has(uid) ? besitzKarte.get(uid) : null);

  /** Eine Gruppe geöffneter Einträge [{fh, st, rel}] prüfen und angleichen. */
  const stapelAbgleichen = async (liste) => {
    const nutzbar = liste.filter((e) => e.st.isDirectory() || e.st.isFile());
    if (!nutzbar.length) return false;
    const r = await system.ausfuehren('getfacl', ['-p', '--', ...nutzbar.map((e) => magisch(e.fh))], { erlaubteCodes: [0, 1] });
    const ist = getfaclParsen(r.stdout);
    const besitz = new Map(); const setzen = new Map(); // neue uid → Pfade, Soll-Text → Pfade
    for (const e of nutzbar) {
      const soll = sollFuer(e.rel);
      stat.geprueft++;
      const neu = soll.eingeschraenktUids.has(e.st.uid) ? 0 : besitzNeu(e.st.uid);
      if (neu !== null && neu !== e.st.uid) { if (!besitz.has(neu)) besitz.set(neu, []); besitz.get(neu).push(magisch(e.fh)); }
      const zeilen = sollFuerArt(soll, e.st);
      if (!gleicheAcl(ist.get(magisch(e.fh))?.eintraege, zeilen)) {
        const text = zeilen.join('\n') + '\n';
        if (!setzen.has(text)) setzen.set(text, []);
        setzen.get(text).push(magisch(e.fh));
      }
    }
    // erst den Besitz (sonst gäbe der Besitzer-Eintrag dem Eingeschränkten Vollzugriff und chmod), dann die ACL
    for (const [uid, pfade] of besitz) { await system.ausfuehren('chown', [String(uid), '--', ...pfade]); stat.besitz += pfade.length; }
    for (const [text, pfade] of setzen) { await system.ausfuehren('setfacl', ['--set-file=-', '--', ...pfade], { eingabe: text }); stat.geaendert += pfade.length; }
    return besitz.size > 0 || setzen.size > 0;
  };

  /** Inhalt eines (offenen) Ordners abgleichen, Unterordner der Reihe nach (höchstens Tiefe + STAPEL Griffe offen). */
  const ordnerAbgleichen = async (fh, rel) => {
    let namen;
    try { namen = (await fsp.readdir(`/proc/self/fd/${fh.fd}`)); } catch { return; }
    const unterordner = [];
    for (let i = 0; i < namen.length; i += STAPEL) {
      if (abgebrochen()) return;
      const stapel = [];
      for (const name of namen.slice(i, i + STAPEL)) {
        let k;
        try { k = await oeffnen(fh.fd, name, false); } catch { continue; } // inzwischen weg
        let st;
        try { st = await k.stat(); } catch { await schliessen(k); continue; }
        stapel.push({ fh: k, st, rel: unter(rel, name), name });
      }
      try { await stapelAbgleichen(stapel); } finally {
        for (const e of stapel) { if (e.st.isDirectory()) unterordner.push(e.name); await schliessen(e.fh); }
      }
      fortschritt(stat.geprueft);
    }
    for (const name of unterordner) {
      if (abgebrochen()) return;
      let k;
      // erneut öffnen – mit O_DIRECTORY|O_NOFOLLOW: wurde der Ordner inzwischen gegen eine Verknüpfung getauscht, schlägt das fehl
      try { k = await oeffnen(fh.fd, name, true); } catch { continue; }
      try { await ordnerAbgleichen(k, unter(rel, name)); } finally { await schliessen(k); }
    }
  };

  try {
    let fh = await oeffnen(null, wurzel, true);
    for (const teil of String(start || '').split('/').filter(Boolean)) {
      let k;
      try { k = await oeffnen(fh.fd, teil, true); } catch { stat.fehlt = true; return stat; }
      await schliessen(fh); fh = k;
    }
    const st = await fh.stat();
    const anders = await stapelAbgleichen([{ fh, st, rel: start }]);
    if (nurWurzel && !anders) return stat;
    stat.gruendlich = true;
    await ordnerAbgleichen(fh, start);
    return stat;
  } finally {
    for (const fh of [...offen]) await fh.close().catch(() => {});
  }
}

/**
 * Ordner unter einer vertrauenswürdigen Wurzel ohne Verknüpfungen öffnen (O_PATH|O_DIRECTORY|O_NOFOLLOW je Teil) – für
 * Einhängungen als root: der Griff zeigt fest auf genau diesen Ordner, `/proc/<pid>/fd/<n>` taugt als Ziel für
 * `mount --no-canonicalize`. null, wenn ein Teil fehlt oder kein echter Ordner ist. Der Aufrufer schließt den Griff.
 */
export async function ordnerGriff(wurzel, rel) {
  let fh = await fsp.open(wurzel, O_PATH | K.O_NOFOLLOW | K.O_DIRECTORY);
  for (const teil of String(rel || '').split('/').filter(Boolean)) {
    let k;
    try { k = await fsp.open(`/proc/self/fd/${fh.fd}/${teil}`, O_PATH | K.O_NOFOLLOW | K.O_DIRECTORY); } catch { await fh.close().catch(() => {}); return null; }
    await fh.close().catch(() => {}); fh = k;
  }
  return fh;
}

/** Pfad, unter dem ein anderer Prozess (mount, getfacl …) genau den Eintrag hinter dem Griff erreicht. */
export function griffPfad(fh) { return `/proc/${process.pid}/fd/${fh.fd}`; }
