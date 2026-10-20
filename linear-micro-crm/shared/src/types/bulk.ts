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

/**
 * One person read from a pasted line, e.g. "Jordan 65 22 11 5 3 3", "Jordan L - 65/22/11/5/3/3",
 * "amelia: 40 12 6 2 1 1". A line naming two people ("Jordan 65 22 11 5 3 3, Sam 40 12 6 2 1 1") gives two.
 */
export interface ParsedPasteLine {
  /** 1-based line number in the pasted text. */
  line: number;
  /** Unique within one result: "4", or "4.1" / "4.2" when line 4 names two people. Choices are keyed by it. */
  key: string;
  raw: string;
  /** The name as written (filler such as "gauges for" left out), or the WhatsApp sender's name. */
  name: string;
  /** Where the name came from: the line itself, or the WhatsApp sender when the line has no name; null → none. */
  nameFrom: 'line' | 'sender' | null;
  /** Candidate members: one → matched, several → ambiguous (ask), none → unknown. */
  matches: number[];
  /** Set when exactly one member matched (or the person chose). */
  userId: number | null;
  /** True when the one match is a near miss (a typo or short form), worth a glance. */
  guess: boolean;
  /** The six gauges in funnel order; null when six numbers could not be read. */
  values: GaugeTotals | null;
  /** A check-in time written on the line ("in 9:58"), as "HH:mm"; null when none. */
  checkIn: string | null;
  /** Problems to show on the row ("Found 5 numbers, need 6", "To table (22) is more than stops (12)"). */
  issues: string[];
  /** Key of a later complete line for the same person, which fills the table instead of this one; null otherwise. */
  replacedBy: string | null;
}

export interface PasteParseResult {
  lines: ParsedPasteLine[];
  /** Lines skipped as chatter (no numbers, timestamps only, emojis only). */
  ignored: number;
}
