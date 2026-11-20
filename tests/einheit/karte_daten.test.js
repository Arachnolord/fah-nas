// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Tests für die Kartendaten der Weltkarte, erzeugt von tools/karte_bauen.mjs aus Natural Earth (gemeinfrei):
// public/karte/welt.json (Umrisse, Vertrag Spec §4.4) und geo/laender.json (Landesmitten + deutsche Namen, §4.3).
// Geprüft werden Größe (statisch.js komprimiert nicht → ≤ 400 KB), Form, deutsche Namen, Datumsgrenze (keine Streifen
// quer über die Karte), gemeinsame Grenzen mit denselben Stützpunkten (keine Spalten beim Zoomen) und eine Feinheits-
// Untergrenze. Dazu die reinen Helfer des Werkzeugs (Vereinfachung, Differenzkodierung).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vereinfacheLinie, kodiereRing, zerlege, baueWelt, baueLaender, kennung } from '../../tools/karte_bauen.mjs';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WELT_DATEI = path.join(WURZEL, 'public', 'karte', 'welt.json');
const LAENDER_DATEI = path.join(WURZEL, 'geo', 'laender.json');
const GRENZE_BYTE = 400_000;

const welt = JSON.parse(fs.readFileSync(WELT_DATEI, 'utf8'));
const laender = JSON.parse(fs.readFileSync(LAENDER_DATEI, 'utf8'));

/** Ring aus der Differenzkodierung zurück in ganze Zahlen (1/q Grad): [[x,y], …]. */
function dekodiere(r) {
  const punkte = [];
  let x = 0; let y = 0;
  for (let i = 0; i < r.length; i += 2) {
    x = i === 0 ? r[0] : x + r[i]; y = i === 0 ? r[1] : y + r[i + 1];
    punkte.push([x, y]);
  }
  return punkte;
}
/** Geschlossene Form: letzter Punkt = erster (wird ergänzt, wenn offen gespeichert). */
function geschlossen(punkte) {
  const [a, z] = [punkte[0], punkte.at(-1)];
  return a[0] === z[0] && a[1] === z[1] ? punkte : [...punkte, a];
}
const land = (iso) => welt.laender.find((l) => l.iso === iso);

test('welt.json: Größe ≤ 400 KB, Kopf v/q/quelle, kompakt geschrieben', () => {
  const groesse = fs.statSync(WELT_DATEI).size;
  assert.ok(groesse <= GRENZE_BYTE, `welt.json ist ${groesse} Byte groß (Grenze ${GRENZE_BYTE})`);
  assert.equal(welt.v, 1);
  assert.equal(welt.q, 100);
  assert.match(welt.quelle, /Natural Earth/);
  assert.ok(!fs.readFileSync(WELT_DATEI, 'utf8').includes('\n '), 'ohne Einrückung');
});

test('welt.json: mindestens 170 Länder, eindeutige Kennungen, keine Antarktis, deutsche Namen', () => {
  assert.ok(Array.isArray(welt.laender) && welt.laender.length >= 170, `nur ${welt.laender?.length} Länder`);
  const gesehen = new Set();
  for (const l of welt.laender) {
    assert.match(l.iso, /^[A-Z]{2,3}$/, `Kennung ${l.iso} (${l.name})`);
    assert.ok(!l.iso.includes('-99'));
    assert.ok(!gesehen.has(l.iso), `Kennung ${l.iso} doppelt`); gesehen.add(l.iso);
    assert.equal(typeof l.name, 'string'); assert.ok(l.name.length > 0);
    // Nur die Antarktis selbst fliegt raus – die Französischen Süd- und Antarktisgebiete (Kerguelen, TF) bleiben.
    assert.notEqual(l.iso, 'AQ'); assert.ok(!/^antar[ck]ti(ka|s|ca)$/i.test(l.name), `Antarktis gehört nicht auf die Karte: ${l.name}`);
  }
  assert.ok(land('TF'), 'Französische Süd- und Antarktisgebiete (subantarktische Inseln) bleiben');
  assert.equal(land('DE').name, 'Deutschland');
  assert.equal(land('US').name, 'Vereinigte Staaten');
  assert.equal(land('AT').name, 'Österreich');
  for (const iso of ['FR', 'NO', 'RU', 'FJ', 'JP', 'BR', 'AU', 'ZA', 'IN', 'CN']) assert.ok(land(iso), `${iso} fehlt auf der Karte`);
});

test('welt.json: Beschriftungspunkte und Ringe im Wertebereich, ganzzahlig, geschlossen oder schließbar', () => {
  let ringe = 0;
  for (const l of welt.laender) {
    assert.ok(Array.isArray(l.p) && l.p.length === 2 && l.p.every(Number.isInteger), `${l.iso}: p`);
    assert.ok(l.p[0] >= -18000 && l.p[0] <= 18000 && l.p[1] >= -9000 && l.p[1] <= 9000, `${l.iso}: p außerhalb`);
    assert.ok(Array.isArray(l.r) && l.r.length >= 1, `${l.iso}: keine Ringe`);
    for (const r of l.r) {
      ringe++;
      assert.ok(r.length % 2 === 0 && r.every(Number.isInteger), `${l.iso}: Ring nicht aus ganzen Zahlenpaaren`);
      const punkte = geschlossen(dekodiere(r));
      assert.ok(punkte.length >= 4, `${l.iso}: Ring mit ${punkte.length} Punkten`);
      for (const [x, y] of punkte) assert.ok(x >= -18000 && x <= 18000 && y >= -9000 && y <= 9000, `${l.iso}: Punkt ${x},${y}`);
    }
  }
  assert.ok(ringe >= 500, `nur ${ringe} Ringe`);
});

test('welt.json: Datumsgrenze – kein Ring springt oder spannt über 180°, Russland und Fidschi liegen auf beiden Seiten', () => {
  for (const l of welt.laender) {
    for (const r of l.r) {
      const punkte = geschlossen(dekodiere(r));
      for (let i = 1; i < punkte.length; i++) {
        assert.ok(Math.abs(punkte[i][0] - punkte[i - 1][0]) < 18000, `${l.iso}: Sprung über die Datumsgrenze (Streifen quer über die Karte)`);
      }
      const xs = punkte.map((p) => p[0]);
      assert.ok(Math.max(...xs) - Math.min(...xs) < 18000, `${l.iso}: Ring spannt über 180° Länge`);
    }
  }
  for (const iso of ['RU', 'FJ']) {
    const xs = land(iso).r.flatMap((r) => dekodiere(r).map((p) => p[0]));
    assert.ok(Math.max(...xs) >= 17900, `${iso}: Teil östlich von 179° fehlt`);
    assert.ok(Math.min(...xs) <= -17900, `${iso}: Teil westlich von −179° fehlt`);
  }
});

test('welt.json: gemeinsame Grenzen haben in beiden Ländern dieselben Stützpunkte (keine Spalten beim Zoomen)', () => {
  // Kriterium auf Kantenebene: jede Kante von A, deren beide Enden auch in B liegen (= gemeinsamer Grenzverlauf), ist
  // auch eine Kante von B. Bei getrennt vereinfachten Ringen fehlen in B die Zwischenpunkte bzw. es gibt andere.
  // (Ein Lauf kann in B über mehrere Ringe gehen – z. B. US–CA am Sankt-Lorenz-Strom über eine kanadische Insel.)
  const kantenVon = (ringe) => {
    const k = new Set();
    for (const r of ringe) {
      for (let i = 0; i < r.length; i++) { const u = r[i].join(','); const v = r[(i + 1) % r.length].join(','); k.add(`${u}|${v}`); k.add(`${v}|${u}`); }
    }
    return k;
  };
  for (const [a, b] of [['DE', 'AT'], ['DE', 'FR'], ['US', 'CA'], ['FR', 'ES'], ['RU', 'CN'], ['IN', 'CN'], ['BR', 'AR']]) {
    const pa = land(a).r.map(dekodiere); const pb = land(b).r.map(dekodiere);
    const punkteB = new Set(pb.flat().map((p) => p.join(','))); const kantenB = kantenVon(pb);
    let gemeinsam = 0; const fremd = [];
    for (const r of pa) {
      for (let i = 0; i < r.length; i++) {
        const u = r[i].join(','); const v = r[(i + 1) % r.length].join(',');
        if (!punkteB.has(u) || !punkteB.has(v)) continue;
        gemeinsam++;
        if (!kantenB.has(`${u}|${v}`)) fremd.push(`${u}→${v}`);
      }
    }
    assert.ok(gemeinsam >= 10, `${a}–${b}: gemeinsamer Grenzverlauf nur ${gemeinsam} Kanten`);
    assert.deepEqual(fremd, [], `${a}–${b}: Grenze in ${b} mit anderen Stützpunkten`);
  }
});

test('welt.json: Umrisse nicht plump – Feinheits-Untergrenze', () => {
  const zaehle = (l) => l.r.reduce((s, r) => s + r.length / 2, 0);
  const gesamt = welt.laender.reduce((s, l) => s + zaehle(l), 0);
  assert.ok(gesamt >= 30_000, `nur ${gesamt} Stützpunkte insgesamt`);
  assert.ok(zaehle(land('DE')) >= 100, `Deutschland nur mit ${zaehle(land('DE'))} Stützpunkten`);
  assert.ok(zaehle(land('NO')) >= 300, `Norwegen (Fjorde) nur mit ${zaehle(land('NO'))} Stützpunkten`);
});

test('laender.json: Quelle, ≥ 170 Länder mit alpha-2-Schlüssel, deutschen Namen und plausiblen Mitten', () => {
  assert.match(laender.quelle, /Natural Earth/);
  const eintraege = Object.entries(laender.laender);
  assert.ok(eintraege.length >= 170, `nur ${eintraege.length} Länder`);
  for (const [iso, l] of eintraege) {
    assert.match(iso, /^[A-Z]{2}$/, `Schlüssel ${iso}`);
    assert.notEqual(iso, 'AQ');
    assert.equal(typeof l.name, 'string'); assert.ok(l.name.length > 0, iso);
    assert.ok(Number.isFinite(l.lat) && l.lat >= -90 && l.lat <= 90, `${iso}: lat`);
    assert.ok(Number.isFinite(l.lon) && l.lon >= -180 && l.lon <= 180, `${iso}: lon`);
  }
  const bereiche = { // [latMin, latMax, lonMin, lonMax]
    DE: [47, 55, 6, 15], US: [25, 50, -125, -65], FR: [42, 51, -5, 8], JP: [30, 45, 129, 146], BR: [-34, 5, -74, -34],
    AU: [-40, -10, 113, 154], ZA: [-35, -22, 16, 33], IN: [8, 35, 68, 97], CN: [18, 54, 73, 135], RU: [41, 82, 19, 180],
    NO: [57, 72, 4, 31],
  };
  for (const [iso, [a, b, c, d]] of Object.entries(bereiche)) {
    const l = laender.laender[iso];
    assert.ok(l, `${iso} fehlt in laender.json`);
    assert.ok(l.lat >= a && l.lat <= b && l.lon >= c && l.lon <= d, `${iso}: Mitte ${l.lat}/${l.lon} unplausibel`);
  }
  assert.equal(laender.laender.DE.name, 'Deutschland');
  assert.equal(laender.laender.US.name, 'Vereinigte Staaten');
});

test('laender.json ⇄ welt.json: jedes Land der Karte mit alpha-2-Kennung hat eine Landesmitte', () => {
  for (const l of welt.laender) if (/^[A-Z]{2}$/.test(l.iso)) assert.ok(laender.laender[l.iso], `${l.iso} (${l.name}) fehlt in laender.json`);
});

test('Werkzeug: Douglas-Peucker behält Endpunkte und Ausreißer, Differenzkodierung wie im Vertrag §4.4', () => {
  // Flacher Verlauf mit einer Spitze bei x=3,5: die Spitze und ihre Fußpunkte bleiben, das Zittern (±0,1) fällt weg.
  const linie = [[0, 0], [1, 0.1], [2, -0.1], [3, 0], [3.5, 4], [4, 0], [5, 0.1], [6, 0]];
  assert.deepEqual(vereinfacheLinie(linie, 0.5), [[0, 0], [3, 0], [3.5, 4], [4, 0], [6, 0]]);
  assert.deepEqual(vereinfacheLinie(linie, 5), [[0, 0], [6, 0]], 'große Toleranz: nur die Endpunkte');
  assert.deepEqual(vereinfacheLinie([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]]);
  // Geschlossene Linie (Anfang = Ende): der entfernteste Punkt wird Anker, Form bleibt erhalten.
  const insel = vereinfacheLinie([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], 0.5);
  assert.deepEqual(insel, [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]);
  // Beispiel aus dem Vertrag: [[10,50],[10.1,50],[10.1,50.1],[10,50.1]] in 1/100 Grad
  assert.deepEqual(kodiereRing([[1000, 5000], [1010, 5000], [1010, 5010], [1000, 5010]]), [1000, 5000, 10, 0, 0, 10, -10, 0]);
});

// Kleines GeoJSON für die Werkzeug-Tests: Merkmal mit Natural-Earth-Feldern
const merkmal = (eigenschaften, ringe) => ({ type: 'Feature', properties: { LABEL_X: 0, LABEL_Y: 0, ...eigenschaften }, geometry: { type: 'Polygon', coordinates: ringe } });

test('Werkzeug: gemeinsame Grenze wird EINMAL vereinfacht – beide Länder behalten dieselben Grenzpunkte samt Dreiländerecke', () => {
  // Zittrige Grenze bei lon 10 (±0,03°, unter der Toleranz 0,05°). Für A läuft die Küste am oberen Grenzende geradeaus
  // weiter – getrennt vereinfacht würde A diesen Punkt wegkürzen, B (Ecke) nicht → Spalt. Gemeinsam: Knoten, bleibt.
  const zitter = (i) => Math.round(Math.sin(i * 1.7) * 3) / 100;
  const grenze = Array.from({ length: 41 }, (_, i) => [10 + zitter(i), i * 0.25]);
  const a = [[0, 0], ...grenze, [10, 20], [0, 20], [0, 0]];
  const b = [grenze[0], [20, 0], [20, 10], ...[...grenze].reverse()];
  const welt = baueWelt(zerlege({ features: [merkmal({ ISO_A2: 'AA', NAME: 'A' }, [a]), merkmal({ ISO_A2: 'BB', NAME: 'B' }, [b])] }), 5);
  const punkte = (iso) => welt.laender.find((l) => l.iso === iso).r.flatMap(dekodiere);
  const anDerGrenze = (iso) => new Set(punkte(iso).filter(([x, y]) => x >= 900 && x <= 1100 && y <= 1000).map((p) => p.join(',')));
  const ecke = `${Math.round(grenze[40][0] * 100)},${Math.round(grenze[40][1] * 100)}`;
  assert.ok(anDerGrenze('AA').has(ecke), 'Dreiländerecke bleibt in A erhalten');
  assert.deepEqual([...anDerGrenze('AA')].sort(), [...anDerGrenze('BB')].sort(), 'Grenzpunkte in A und B gleich');
  assert.ok(anDerGrenze('AA').size < 41, 'das Zittern wurde tatsächlich vereinfacht');
});

test('Werkzeug: Kennungen (ISO_A2 → ISO_A2_EH → WB_A2 → Ersatz ADM0_A3), Antarktis raus, gleiche Kennung wird zusammengefasst', () => {
  assert.deepEqual(kennung({ ISO_A2: 'DE' }), { iso: 'DE', alpha2: true, rang: 0 });
  assert.deepEqual(kennung({ ISO_A2: '-99', ISO_A2_EH: 'FR', WB_A2: 'FR' }), { iso: 'FR', alpha2: true, rang: 1 });
  assert.deepEqual(kennung({ ISO_A2: 'CN-TW', ISO_A2_EH: 'TW', WB_A2: '-99' }), { iso: 'TW', alpha2: true, rang: 1 });
  assert.deepEqual(kennung({ ISO_A2: '-99', ISO_A2_EH: '-99', WB_A2: 'KV' }), { iso: 'KV', alpha2: true, rang: 2 });
  assert.deepEqual(kennung({ ISO_A2: '-99', ISO_A2_EH: '-99', WB_A2: '-99', ADM0_A3: 'SOL' }), { iso: 'SOL', alpha2: false, rang: 3 });
  assert.equal(kennung({ ISO_A2: '-99', ISO_A2_EH: '-99', WB_A2: '-99' }), null);
  const quadrat = (x, y, s) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
  const z = zerlege({ features: [
    merkmal({ ISO_A2: 'AQ', ADM0_A3: 'ATA', NAME: 'Antarctica', NAME_DE: 'Antarktika' }, quadrat(0, -80, 5)),
    merkmal({ ISO_A2: '-99', ISO_A2_EH: 'AU', ADM0_A3: 'IOA', NAME: 'Indian Ocean Ter.', LABEL_X: 105, LABEL_Y: -10 }, quadrat(105, -11, 1)),
    merkmal({ ISO_A2: 'AU', NAME: 'Australia', NAME_DE: 'Australien', LABEL_X: 134, LABEL_Y: -25 }, quadrat(120, -35, 20)),
    merkmal({ ISO_A2: '-99', ISO_A2_EH: '-99', WB_A2: '-99', ADM0_A3: 'SOL', NAME: 'Somaliland', LABEL_X: 46, LABEL_Y: 9.5 }, quadrat(44, 8, 3)),
  ] });
  const welt = baueWelt(z, 4);
  assert.deepEqual(welt.laender.map((l) => l.iso), ['AU', 'SOL'], 'Antarktis raus, AU einmal, Ersatzkennung bleibt auf der Karte');
  const au = welt.laender[0];
  assert.equal(au.name, 'Australien', 'Name vom Hauptteil (ISO_A2 direkt)');
  assert.deepEqual(au.p, [13400, -2500], 'Beschriftungspunkt vom Hauptteil');
  assert.equal(au.r.length, 2, 'Ringe beider Teile');
  const laender = baueLaender(z);
  assert.deepEqual(Object.keys(laender.laender), ['AU'], 'laender.json nur mit echten alpha-2-Kennungen');
  assert.deepEqual(laender.laender.AU, { name: 'Australien', lat: -25, lon: 134 });
});
