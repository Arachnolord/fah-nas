// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Typ-Register des Sync-Motors (V12/V16): Name der Office-Art → Typ. Plan 05 ergänzt „dokument“, Plan 06 „tabelle“.
// Der Web-Dienst lädt es als ../../../public/gemeinsam/sync/typen/index.js.

import { board } from './board.js';
import { dokument } from './dokument.js';
import { tabelle } from './tabelle.js';

export const TYPEN = Object.freeze({ board, dokument, tabelle });
