/**
 * Release 1.2 — U2 bulk-entry contracts (laid down by r2-foundation; OWNED BY U2, which may add fields and types).
 *
 * POST /gauges/bulk (leader: own team's events and members; admin: any) — all rows valid or nothing saved. Same rules
 * as POST /gauges per row (funnel, event started and not cancelled, date = event date, member of the event's team,
 * paid-week lock, rate snapshot, payroll sync), one transaction, one data-version bump.
 *  → 200 BulkGaugeResult
 *  → 400 { error, details: { rows: BulkRowError[] } } when any row is invalid (nothing saved)
 */
import type { GaugeEntryWithMeta, GaugeTotals } from '../types.ts';

export interface BulkGaugeRow extends GaugeTotals {
  userId: number;
  /** Same format and rules as GaugeUpsertInput.checkedInAt; omitted keeps a stored value, null clears it. */
  checkedInAt?: string | null;
  notes?: string | null;
}

export interface BulkGaugeInput {
  eventId: number;
  /** Must equal the event's date. */
  date: string;
  rows: BulkGaugeRow[];
}

export interface BulkRowError {
  /** Index into `rows`. */
  index: number;
  userId: number | null;
  errors: string[];
}

export interface BulkGaugeResult {
  created: number;
  updated: number;
  entries: GaugeEntryWithMeta[];
}

// ── "Paste from WhatsApp" (shared/src/logic/bulkPaste.ts, pure) ──

/** A team member the parser may match names against. */
export interface PasteMember {
  userId: number;
  firstName: string;
  lastName: string;
}

/** One pasted line, e.g. "Jordan 65 22 11 5 3 3", "Jordan L - 65/22/11/5/3/3", "amelia: 40 12 6 2 1 1". */
export interface ParsedPasteLine {
  /** 1-based line number in the pasted text. */
  line: number;
  raw: string;
  /** The name as written. */
  name: string;
  /** Candidate members: one → matched, several → ambiguous (ask), none → unknown. */
  matches: number[];
  /** Set when exactly one member matched (or the person chose). */
  userId: number | null;
  /** The six gauges in funnel order; null when six numbers could not be read. */
  values: GaugeTotals | null;
  /** Problems to show on the row ("Found 5 numbers, need 6", "Table is more than stops"). */
  issues: string[];
}

export interface PasteParseResult {
  lines: ParsedPasteLine[];
  /** Lines skipped as chatter (no numbers, timestamps only, emojis only). */
  ignored: number;
}
