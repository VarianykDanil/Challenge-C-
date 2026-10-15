/**
 * Recruitment pipeline metrics.
 * Open stages: applied → screening → interview → observation → offer. Terminal: hired, rejected, withdrawn.
 */
import type { CandidateStage } from '../types.ts';
import { PIPELINE_STAGES, TERMINAL_STAGES } from '../types.ts';
import { DAY_MS, dateOnly, daysBetween, isValidISODate, toISODate } from './dates.ts';

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
