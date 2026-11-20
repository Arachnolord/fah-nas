// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// V7 SSE-Privatsphäre (Plan 02, Aufgabe 10): Chat- und Office-Ereignisse des Agenten gehen nie über SSE – auch nicht an
// Admins (vorher bekamen Admins jede unbekannte Ereignisart).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmp, warte, standardAttrappe, dienstStarten, Browser, sseLesen } from './web_hilfen.js';
import { PRIVATE_EREIGNISSE } from '../../src/web/sse.js';

test('chat/office gehen nie über SSE, auch nicht an Admins', async () => {
  assert.deepEqual([...PRIVATE_EREIGNISSE].sort(), ['chat', 'office']);
  const a = await standardAttrappe(await tmp());
  const { dienst, port } = await dienstStarten(a, { heartbeat_ms: 50 });
  try {
    const admin = new Browser(port); await admin.anmelden('fabian', 'geheim123');
    const strom = sseLesen(port, admin.kopf(), (t) => t.includes('"bereich":"ende"'));
    await warte(80);
    a.ereignis({ ereignis: 'chat', raum: 'r1', art: 'nachricht', daten: { text: 'GEHEIM' }, an: { nutzer: ['fabian'], gaeste: [] } });
    a.ereignis({ ereignis: 'office', dok: 'x', daten: 'GEHEIM' });
    a.ereignis({ ereignis: 'konfig', bereich: 'ende' });
    const { text } = await strom;
    assert.ok(!text.includes('GEHEIM'));
    assert.ok(!/event: (chat|office)/.test(text));
  } finally { await dienst.stoppen(); await a.stoppen(); }
});
