/**
 * The role-scoped "Needs attention" feed — OWNED BY p5-needs-attention-feed.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p5 replaces the bodies
 * (p5 may reshape AttentionInput, which only its own route fills).
 * Pure: sorted danger → warning → info, then newest first; at most ATTENTION_MAX_ITEMS; deterministic keys.
 */
import type {
  AttentionItem,
  CandidateWithMeta,
  GaugeEntry,
  Interview,
  PayPlan,
  PayrollRunWithUser,
  Role,
  SalesEventWithMeta,
  User,
} from '../types.ts';

export const ATTENTION_MAX_ITEMS = 20;

/** The clock the rules run against (business zone, Europe/London). */
export interface AttentionNow {
  today: string;
  /** "HH:MM" */
  nowHHMM: string;
  nowISO: string;
}

/** Everything the rules read, already scoped to what the caller may see (the route never widens it). */
export interface AttentionInput {
  me: { id: number; role: Role; teamId: number | null; firstName: string; twoFactorEnabled: boolean };
  /** The caller's own pay plan (for "that day's £60 base plus commission"); null when unknown. */
  plan: PayPlan | null;
  /** Events dated today − 3 … tomorrow that the caller may see. */
  events: ReadonlyArray<SalesEventWithMeta>;
  /** Gauge rows on those dates for the people in scope (numbers only). */
  entries: ReadonlyArray<Pick<GaugeEntry, 'id' | 'eventId' | 'userId' | 'date' | 'stops' | 'table' | 'sales' | 'submittedAt'>>;
  /** Active members of the teams in scope (leader: own team; admin: all; rep: themself). */
  members: ReadonlyArray<Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'teamId' | 'startDate' | 'status'>>;
  /** Pending / failed runs, and runs paid in the last 7 days (rep: own; admin: all in the to-pay window). */
  runs: ReadonlyArray<PayrollRunWithUser>;
  /** Open candidates in recruitment scope. */
  candidates: ReadonlyArray<CandidateWithMeta>;
  /** Interviews within ±2 days in recruitment scope. */
  interviews: ReadonlyArray<Interview>;
}

export function attentionItems(input: AttentionInput, now: AttentionNow): AttentionItem[] {
  void input;
  void now;
  return [];
}
