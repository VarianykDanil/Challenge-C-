/**
 * Release 1.2 — OWNED BY U2 bulk-entry (laid down by r2-foundation; the parser body is a stub).
 * Pure: reads a WhatsApp paste ("Jordan 65 22 11 5 3 3", "Jordan L - 65/22/11/5/3/3", "amelia: 40 12 6 2 1 1", with
 * emojis, timestamps and extra words) into rows matched against the team (fuzzy first / full name, ambiguous names
 * flagged for a choice), each with its six gauges and the funnel problems to show. Types: shared/src/types/bulk.ts.
 */
import type { PasteMember, PasteParseResult } from '../types/bulk.ts';

/** STUB (U2) */
export function parseBulkPaste(text: string, members: readonly PasteMember[]): PasteParseResult {
  void text;
  void members;
  return { lines: [], ignored: 0 };
}
