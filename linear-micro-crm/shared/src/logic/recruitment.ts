/**
 * Recruitment pipeline metrics.
 * Open stages: applied → screening → interview → observation → offer. Terminal: hired, rejected, withdrawn.
 */
import type { Candidate, CandidateStage, Interview, Role } from '../types.ts';
import { PIPELINE_STAGES, TERMINAL_STAGES } from '../types.ts';
import { DAY_MS, addDays, dateOnly, daysBetween, isValidISODate, toISODate } from './dates.ts';

/** Position in the happy-path pipeline (0 = applied … 5 = hired); −1 for rejected/withdrawn. */
export function stageIndex(stage: CandidateStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

export function isTerminalStage(stage: CandidateStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** A candidate in an open stage is still being worked (not hired, rejected or withdrawn). */
export function isOpenStage(stage: CandidateStage): boolean {
  return !isTerminalStage(stage);
}

/** The next happy-path stage, or null from `hired`, `rejected` and `withdrawn`. */
export function nextStage(stage: CandidateStage): CandidateStage | null {
  const i = stageIndex(stage);
  if (i < 0 || i >= PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[i + 1];
}

/** The previous happy-path stage, or null from `applied` and the terminal stages. */
export function previousStage(stage: CandidateStage): CandidateStage | null {
  const i = stageIndex(stage);
  if (i <= 0) return null;
  return PIPELINE_STAGES[i - 1];
}

/** Either a map of stage → count or the `funnel` rows from a RecruitmentSummary. */
export type StageCounts =
  | Partial<Record<CandidateStage, number>>
  | ReadonlyArray<{ stage: CandidateStage; count: number }>;

export interface StageConversion {
  from: CandidateStage;
  to: CandidateStage;
  fromCount: number;
  toCount: number;
  /** toCount / fromCount, 0 when nobody reached `from` */
  rate: number;
}

function toCountMap(counts: StageCounts): Record<CandidateStage, number> {
  const map = {} as Record<CandidateStage, number>;
  for (const s of [...PIPELINE_STAGES, ...TERMINAL_STAGES]) map[s] = 0;
  if (Array.isArray(counts)) {
    for (const row of counts as ReadonlyArray<{ stage: CandidateStage; count: number }>) {
      map[row.stage] = (map[row.stage] ?? 0) + Number(row.count ?? 0);
    }
  } else {
    for (const [k, v] of Object.entries(counts as Partial<Record<CandidateStage, number>>)) {
      map[k as CandidateStage] = Number(v ?? 0);
    }
  }
  return map;
}

/**
 * Pass-through rate between each consecutive happy-path stage, given how many candidates
 * *reached* each stage (a cumulative funnel, not a snapshot of who is currently where).
 */
export function stageConversion(counts: StageCounts): StageConversion[] {
  const map = toCountMap(counts);
  const out: StageConversion[] = [];
  for (let i = 1; i < PIPELINE_STAGES.length; i++) {
    const from = PIPELINE_STAGES[i - 1];
    const to = PIPELINE_STAGES[i];
    const fromCount = map[from];
    const toCount = map[to];
    out.push({ from, to, fromCount, toCount, rate: fromCount > 0 ? toCount / fromCount : 0 });
  }
  return out;
}

/** hired / applied (0..1), 0 when nobody applied. */
export function hireRate(applied: number, hired: number): number {
  return applied > 0 ? hired / applied : 0;
}

function toMs(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (isValidISODate(value)) return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  return new Date(value).getTime();
}

/**
 * Whole days from application to hire (rounded to the nearest day, never negative).
 * Accepts dates or timestamps; two `YYYY-MM-DD` values are compared as calendar days.
 */
export function timeToHireDays(appliedAt: string, hiredAt: string): number {
  if (isValidISODate(appliedAt) && isValidISODate(hiredAt)) return Math.max(0, daysBetween(appliedAt, hiredAt));
  const diff = toMs(hiredAt) - toMs(appliedAt);
  if (!Number.isFinite(diff)) return 0;
  return Math.max(0, Math.round(diff / DAY_MS));
}

/** Days a candidate has been in the pipeline, from `appliedAt` until `until` (default now). */
export function daysInPipeline(appliedAt: string, until: string | Date = new Date()): number {
  const end = until instanceof Date ? toISODate(until) : dateOnly(until);
  return timeToHireDays(dateOnly(appliedAt), end);
}

/** Arithmetic mean; 0 for an empty list. Non-finite values are ignored. */
export function avg(values: ReadonlyArray<number>): number {
  let n = 0;
  let total = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    n++;
    total += v;
  }
  return n > 0 ? total / n : 0;
}

/**
 * Is a follow-up overdue? A date-only `nextActionAt` is overdue once `now` is a later calendar day;
 * a timestamp is overdue once `now` is past it. Null/empty is never overdue.
 */
export function isOverdue(nextActionAt: string | null | undefined, now: string | Date = new Date()): boolean {
  if (!nextActionAt) return false;
  if (isValidISODate(nextActionAt)) {
    const today = now instanceof Date ? toISODate(now) : dateOnly(now);
    return today > nextActionAt;
  }
  const due = new Date(nextActionAt).getTime();
  const ref = toMs(now);
  if (Number.isNaN(due) || Number.isNaN(ref)) return false;
  return ref > due;
}

// ─────────────────────────── Stage SLAs (smart release 1.1, p8) ───────────────────────────

/** A stage a candidate is still being worked in (everything except hired, rejected and withdrawn). */
export type SlaStage = 'applied' | 'screening' | 'interview' | 'observation' | 'offer';

/**
 * Target calendar days in each open stage. Moving into a stage sets the next-action deadline this many days ahead,
 * and a candidate who has sat in a stage for longer than this is "idle". Tune them here (nowhere else reads numbers).
 */
export const STAGE_SLA_DAYS: Readonly<Record<SlaStage, number>> = {
  applied: 3,
  screening: 5,
  interview: 7,
  observation: 7,
  offer: 7,
};

/** A pending interview asks for its outcome once it started at least this many hours ago. */
export const OUTCOME_PROMPT_HOURS = 2;

/** How far back the recruiter dashboard looks for pending outcomes (calendar days). */
export const OUTCOME_LOOKBACK_DAYS = 56;

/** The SLA in days for an open stage; null for hired, rejected and withdrawn. */
export function stageSlaDays(stage: CandidateStage): number | null {
  return isTerminalStage(stage) ? null : (STAGE_SLA_DAYS[stage as SlaStage] ?? null);
}

/**
 * The default next-action deadline when a candidate enters `stage` on `today` (`YYYY-MM-DD`): today + the stage SLA,
 * as a date-only `YYYY-MM-DD` (so `isOverdue` treats it as overdue from the following day). Terminal stages → null.
 */
export function defaultNextActionAt(stage: CandidateStage, today: string): string | null {
  const sla = stageSlaDays(stage);
  return sla === null ? null : addDays(dateOnly(today), sla);
}

const BUSINESS_TZ = 'Europe/London';
let londonDateFormat: Intl.DateTimeFormat | null = null;
const LEADING_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const NAIVE_TIMESTAMP_RE =/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * The Europe/London calendar date (`YYYY-MM-DD`) of an instant, whatever zone the machine runs in. A date-only string
 * is already a business date and a naive timestamp (no `Z` / offset) is London wall-clock time, so both keep their own
 * day; anything else is parsed as an instant. Null when the value cannot be read.
 */
export function businessDateOf(value: string | Date): string | null {
  if (typeof value === 'string') {
    // `Date` would roll 31 Feb over to 3 Mar; a written calendar day must be a real one
    if (LEADING_DATE_RE.test(value) && !isValidISODate(value.slice(0, 10))) return null;
    if (isValidISODate(value)) return value;
    if (NAIVE_TIMESTAMP_RE.test(value)) return value.slice(0, 10);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  londonDateFormat ??= new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts: Record<string, string> = {};
  for (const p of londonDateFormat.formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Whole Europe/London calendar days a candidate has sat in their current stage: from the day of `stageUpdatedAt` to
 * the day of `now` (0 on the day they moved, never negative). Null for terminal stages or an unreadable date.
 * A stage change resets `stageUpdatedAt`, so the counter restarts at 0.
 */
export function candidateIdleDays(c: Pick<Candidate, 'stage' | 'stageUpdatedAt'>, now: string | Date = new Date()): number | null {
  if (isTerminalStage(c.stage)) return null;
  const from = businessDateOf(c.stageUpdatedAt);
  const to = businessDateOf(now);
  if (!from || !to) return null;
  return Math.max(0, daysBetween(from, to));
}

/** Idle = more whole days in the stage than its SLA (exactly the SLA is still on target). Never true for terminal stages. */
export function isIdle(c: Pick<Candidate, 'stage' | 'stageUpdatedAt'>, now: string | Date = new Date()): boolean {
  const days = candidateIdleDays(c, now);
  const sla = stageSlaDays(c.stage);
  return days !== null && sla !== null && days > sla;
}

/**
 * Whole days past the stage target: `candidateIdleDays − STAGE_SLA_DAYS[stage]`. Positive = idle by that many days,
 * 0 = exactly on target, negative = days left inside the target. Null for terminal stages or an unreadable date.
 */
export function daysPastTarget(c: Pick<Candidate, 'stage' | 'stageUpdatedAt'>, now: string | Date = new Date()): number | null {
  const days = candidateIdleDays(c, now);
  const sla = stageSlaDays(c.stage);
  return days === null || sla === null ? null : days - sla;
}

/**
 * Comparator for "Longest idle first" (use with `Array.prototype.sort`): the furthest past their stage target first,
 * so every idle candidate comes before every on-target one, and on-target candidates follow nearest-to-target first.
 * Ties: longer in the stage first (earlier `stageUpdatedAt`), then by id. Closed candidates and unreadable dates last.
 */
export function compareLongestIdle(
  a: Pick<Candidate, 'id' | 'stage' | 'stageUpdatedAt'>,
  b: Pick<Candidate, 'id' | 'stage' | 'stageUpdatedAt'>,
  now: string | Date = new Date(),
): number {
  const pa = daysPastTarget(a, now);
  const pb = daysPastTarget(b, now);
  if (pa === null || pb === null) {
    if (pa !== pb) return pa === null ? 1 : -1;
  } else if (pa !== pb) return pb - pa;
  const ta = toMs(a.stageUpdatedAt);
  const tb = toMs(b.stageUpdatedAt);
  const fa = Number.isFinite(ta);
  const fb = Number.isFinite(tb);
  if (fa !== fb) return fa ? -1 : 1;
  if (fa && ta !== tb) return ta - tb;
  return a.id - b.id;
}

/**
 * Does a past interview still need its outcome recorded? Outcome `pending` and `scheduledAt` at least
 * OUTCOME_PROMPT_HOURS (2 h) before `now`. Future or recorded interviews never do.
 */
export function needsOutcome(iv: Pick<Interview, 'outcome' | 'scheduledAt'>, now: string | Date = new Date()): boolean {
  if (iv.outcome !== 'pending') return false;
  const at = toMs(iv.scheduledAt);
  const ref = toMs(now);
  if (!Number.isFinite(at) || !Number.isFinite(ref)) return false;
  return at <= ref - OUTCOME_PROMPT_HOURS * 3_600_000;
}

/**
 * The interviews `me` should record an outcome for: `needsOutcome`, and (unless `me` is an admin, who sees them all)
 * either `me` is the interviewer or `me` owns the candidate. `ownerOf` maps a candidate id to its owner; candidates it
 * does not know (e.g. closed ones the caller did not load) count as not owned. Oldest first, then by id.
 */
export function outcomesToRecord<T extends Pick<Interview, 'id' | 'candidateId' | 'interviewerId' | 'outcome' | 'scheduledAt'>>(
  interviews: ReadonlyArray<T>,
  me: { id: number; role: Role },
  ownerOf: (candidateId: number) => number | null | undefined,
  now: string | Date = new Date(),
): T[] {
  return interviews
    .filter((iv) => needsOutcome(iv, now) && (me.role === 'admin' || iv.interviewerId === me.id || ownerOf(iv.candidateId) === me.id))
    .sort((a, b) => toMs(a.scheduledAt) - toMs(b.scheduledAt) || a.id - b.id);
}
