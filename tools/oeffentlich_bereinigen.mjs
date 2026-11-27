#!/usr/bin/env node
// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Öffentliche Bereinigung für Release und Installer-ISO: dieselben Regeln wie der „Öffentliche Stand“ von FAH-Git
// (Ersetzen + Verboten). Die Regeln selbst sind privat und liegen NICHT im Repo, sondern in einer Datei des Betreibers
// (Standard ~/.config/fah-oeffentlich/regeln.json, Format wie die Bereinigung in FAH-Git:
// {"ersetzen":[{"suchen":"…","durch":"…"}],"verboten":["…"]}; „re:“ vor „suchen“ = regulärer Ausdruck).
//   node tools/oeffentlich_bereinigen.mjs [--regeln <datei>] [--nur-pruefen] [--erlaubt <sha256>]… <ordner> …
// 1) Kopfzeile „Erdacht und programmiert von <Name>, <Straße>, <PLZ Ort>, Deutschland.“ → ohne Anschrift (ohne Regel).
// 2) Ersetzen in Textdateien (UTF-8, ohne NUL, ≤ 8 MB); mit --nur-pruefen wird nichts verändert.
// 3) Prüfen – jeder Fund bricht ab (Rückgabewert 1), ausgegeben werden nur relativer Pfad + Regelnummer, nie der Begriff:
//    - Verboten UND jeder Klartext-Suchbegriff aus „ersetzen“ (Groß/klein egal) in Inhalt (UTF-8, Latin-1, UTF-16) und
//      in Datei-/Ordnernamen; Muster-Regeln („re:“) dürfen in Textdateien nicht mehr treffen
//    - Geheimnisse: private Schlüssel, bekannte Token-Formate
//    - Dateien, die nie öffentlich gehören (Schlüssel, .env, Datenbanken, Logs, VPN-Profile, interne Notizen)
//    - Verweise (Symlinks) und nicht prüfbare Archive (gz, zip, 7z, …) – außer per --erlaubt <sha256> ausdrücklich zugelassen
//      (z. B. das vorher selbst geprüfte Release-Archiv oder ein Fremdarchiv mit fester Prüfsumme)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
let regelnDatei = path.join(os.homedir(), '.config', 'fah-oeffentlich', 'regeln.json');
let nurPruefen = false;
const erlaubt = new Set();
const ordner = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--regeln') regelnDatei = args[++i];
  else if (args[i] === '--nur-pruefen') nurPruefen = true;
  else if (args[i] === '--erlaubt') erlaubt.add(String(args[++i] || '').toLowerCase());
  else ordner.push(args[i]);
}
if (!ordner.length) { console.error('Aufruf: oeffentlich_bereinigen.mjs [--regeln <datei>] [--nur-pruefen] [--erlaubt <sha256>] <ordner> …'); process.exit(2); }
if (!fs.existsSync(regelnDatei)) {
  console.error(`FEHLER: Regeln fehlen (${regelnDatei}) – ohne sie wird nichts Öffentliches gebaut. Aus FAH-Git übernehmen (Einstellungen → GitHub → Bereinigung).`);
  process.exit(2);
}
const regeln = JSON.parse(fs.readFileSync(regelnDatei, 'utf8'));
const ersetzen = (regeln.ersetzen || []).filter((x) => x && String(x.suchen || '').trim()).map((x, i) => {
  const s = String(x.suchen); const d = String(x.durch ?? '');
  return s.startsWith('re:')
    ? { nr: `E${i + 1}`, re: new RegExp(s.slice(3), 'g'), durch: d, klartext: null }
    : { nr: `E${i + 1}`, re: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), durch: d.replace(/\$/g, '$$$$'), klartext: s.toLowerCase() };
});
// Verboten = Verbotsliste + Klartext-Suchbegriffe (die dürfen nach dem Ersetzen nirgends mehr stehen, auch nicht binär)
const verboten = [
  ...(regeln.verboten || []).map((v, i) => ({ nr: `V${i + 1}`, w: String(v).trim().toLowerCase() })),
  ...ersetzen.filter((r) => r.klartext && r.klartext.length >= 4).map((r) => ({ nr: r.nr, w: r.klartext })),
].filter((v) => v.w.length >= 3);
if (!ersetzen.length || !(regeln.verboten || []).length) { console.error('FEHLER: Regeldatei ohne „ersetzen“ oder „verboten“ – so wäre nichts geprüft'); process.exit(2); }
const KOPF = /(Erdacht und programmiert von [^,\n]+),[^,\n]+,\s*\d{5}[^,\n]*,\s*(Deutschland\.)/g;
const SCHLUESSEL = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/;
const TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|fgit_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|sk_live_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|\d{8,10}:AA[A-Za-z0-9_-]{33})/;
const NIE = /(^|\/)(users\.json|memory\.md|CLAUDE\.md|AGENTS\.md|\.claude|\.ssh|\.git|id_(rsa|dsa|ecdsa|ed25519)[^/]*|\.env(\.(?!(example|sample|dist|template|beispiel|vorlage|muster)$)[^/]*)?|[^/]*\.(pem|key|p12|pfx|kdbx|ovpn|db|sqlite|sqlite3|log|tfstate|htpasswd|ppk|jks|keystore)|wg[^/]*\.conf|\.npmrc|\.netrc|\.pypirc|\.git-credentials)$/i;
const ARCHIV = /\.(gz|tgz|zip|7z|xz|bz2|zst|rar|tar|iso|img|dmg|deb|rpm|pdf|jar|apk)$/i;

let geaendert = 0; let geprueft = 0;
const funde = [];
const fund = (rel, was) => { if (funde.length < 60) funde.push(`${rel}: ${was}`); };

function utf16(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  let nullUngerade = 0; const n = Math.min(buf.length, 4096);
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) nullUngerade++;
  return n > 64 && nullUngerade > n / 4;
}

function pruefenText(rel, text) {
  const klein = text.toLowerCase();
  for (const v of verboten) if (klein.includes(v.w)) { fund(rel, `Regel ${v.nr}`); return; }
  for (const r of ersetzen) if (!r.klartext) { r.re.lastIndex = 0; if (r.re.test(text)) { fund(rel, `Regel ${r.nr} (Muster trifft noch)`); return; } }
  if (SCHLUESSEL.test(text)) fund(rel, 'privater Schlüssel');
  else if (TOKEN.test(text)) fund(rel, 'Token-Format');
}

function gehen(wurzel, p) {
  const rel = path.relative(wurzel, p) || path.basename(p);
  const st = fs.lstatSync(p);
  for (const v of verboten) if (rel.toLowerCase().includes(v.w)) { fund(rel, `Regel ${v.nr} im Namen`); break; }
  if (st.isSymbolicLink()) { fund(rel, 'Verweis (Symlink) – nicht prüfbar'); return; }
  if (st.isDirectory()) { if (NIE.test(rel)) fund(rel, 'Ordner gehört nie in ein öffentliches Paket'); for (const n of fs.readdirSync(p)) gehen(wurzel, path.join(p, n)); return; }
  if (!st.isFile()) { fund(rel, 'keine normale Datei'); return; }
  geprueft++;
  if (NIE.test(rel)) { fund(rel, 'Datei gehört nie in ein öffentliches Paket'); return; }
  let buf = fs.readFileSync(p);
  if (ARCHIV.test(rel)) {
    const summe = crypto.createHash('sha256').update(buf).digest('hex');
    if (!erlaubt.has(summe)) { fund(rel, 'Archiv – Inhalt nicht prüfbar (nur mit --erlaubt <sha256>)'); return; }
  }
  const istUtf8 = buf.length <= 8 * 1024 * 1024 && !buf.subarray(0, 8192).includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
  if (istUtf8) {
    const text = buf.toString('utf8');
    if (!nurPruefen) {
      let neu = text.replace(KOPF, '$1, $2');
      for (const r of ersetzen) { r.re.lastIndex = 0; neu = neu.replace(r.re, r.durch); }
      if (neu !== text) { fs.writeFileSync(p, neu); buf = Buffer.from(neu, 'utf8'); geaendert++; }
    }
    pruefenText(rel, buf.toString('utf8'));
    return;
  }
  // Binär: Latin-1 und (falls danach aussehend) UTF-16 durchsuchen – geändert wird hier nie etwas
  const kandidaten = [buf.toString('latin1')];
  if (utf16(buf)) kandidaten.push(buf.toString('utf16le'));
  for (const k of kandidaten) {
    const klein = k.toLowerCase();
    const v = verboten.find((x) => klein.includes(x.w));
    if (v) { fund(rel, `Regel ${v.nr} (binär)`); return; }
    if (SCHLUESSEL.test(k)) { fund(rel, 'privater Schlüssel (binär)'); return; }
  }
}

for (const o of ordner) { const w = path.resolve(o); gehen(path.dirname(w), w); }
if (funde.length) {
  console.error(`FEHLER: ${funde.length}${funde.length >= 60 ? '+' : ''} Fund(e) – nichts Öffentliches bauen:`);
  for (const f of funde) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`Öffentliche Bereinigung${nurPruefen ? ' (nur prüfen)' : ''}: ${geprueft} Dateien geprüft, ${geaendert} angepasst, 0 Funde.`);
