// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// NDJSON-Rahmen für Unix-Sockets: eine JSON-Zeile je Nachricht. Schützt vor zu langen Zeilen.

import crypto from 'node:crypto';
import { FahnasFehler } from './fehler.js';

/**
 * Obergrenze je Nachricht (Anfrage wie Antwort). Große Listen (z. B. dateien.liste mit Zehntausenden Einträgen)
 * dürfen nicht die Steuerverbindung reißen; der Agent prüft Ergebnisse vor dem Senden gegen diese Grenze
 * (E_SYSTEM „Ergebnis zu groß“ statt Verbindungsabriss). Rohdaten laufen über den Datenkanal.
 */
export const MAX_ZEILE = 64 * 1024 * 1024;

/**
 * Hängt einen Zeilenleser an einen Socket. `beiNachricht(obj)` je vollständiger Zeile,
 * `beiFehler(fehler)` bei kaputtem JSON oder Überlänge (Verbindung sollte dann geschlossen werden).
 */
export function zeilenleser(socket, beiNachricht, beiFehler) {
  let puffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (teil) => {
    puffer += teil;
    if (puffer.length > MAX_ZEILE) {
      puffer = '';
      beiFehler(new FahnasFehler('E_PARAMS', 'Nachricht zu groß'));
      return;
    }
    let i;
    while ((i = puffer.indexOf('\n')) >= 0) {
      const zeile = puffer.slice(0, i);
      puffer = puffer.slice(i + 1);
      if (!zeile.trim()) continue;
      let obj;
      try { obj = JSON.parse(zeile); } catch { beiFehler(new FahnasFehler('E_PARAMS', 'Ungültiges JSON')); continue; }
      beiNachricht(obj);
    }
  });
}

/** Schreibt ein Objekt als eine Zeile; gibt false zurück, wenn der Socket schon zu ist. */
export function sende(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  socket.write(JSON.stringify(obj) + '\n');
  return true;
}

/**
 * Erzeugt eine kurze, nicht vorhersagbare Kennung (für Anfragen, Aufgaben, Tickets) aus dem Zufallsgenerator
 * des Betriebssystems – nie aus Math.random (V8 xorshift128+ ist aus Ausgaben rekonstruierbar, und Tickets
 * sind Inhaber-Geheimnisse).
 */
export function kennung(vorsilbe = '') {
  return vorsilbe + crypto.randomBytes(12).toString('base64url');
}
