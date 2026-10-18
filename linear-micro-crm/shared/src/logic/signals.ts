/**
 * "Check in with…" signals for leaders and the owner — OWNED BY p4-leader-check-ins-coaching.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p4 replaces the bodies
 * (p4 may reshape PersonSignalInput, which only its own server builder fills).
 * Reasons are conversation starters, not verdicts: never "at risk", "underperforming" or "failing".
 */
import type { CheckInPerson, CheckInReason, CheckInReasonCode, GaugeTotals, Position } from '../types.ts';
import type { WeekStat } from './stats.ts';

export const CHECK_IN_RULES: {
  maxPeople: number;
  minScore: number;
  weights: Readonly<Record<CheckInReasonCode, number>>;
} = {
  maxPeople: 5,
  minScore: 2,
  weights: {
    sustained_decline: 3,
    conversion_drop: 3,
    stops_drop: 2,
    attendance_drop: 2,
    zero_week: 2,
    earnings_drop: 2,
    trainee_slow: 2,
    late_often: 1,
  },
};

export interface PersonSignalInput {
  today: string;
  position: Position;
  startDate: string;
  /** 16 completed Mon–Sun weeks before this Monday, oldest first, zero-filled (server weeklyHistory). */
  weeks16: ReadonlyArray<WeekStat>;
  /** This week so far (Monday up to yesterday). */
  current: WeekStat;
  /** Minutes late of the person's recorded check-ins in the last 8 weeks, newest first (≤ 0 = on time). */
  lateMinutes: ReadonlyArray<number>;
  /** The team's share of late check-ins over the same 8 weeks (0..1); null when the team recorded none. */
  teamLateShare: number | null;
  /** The person's gauge dates and the team's completed event dates: last 14 days, and the 8 weeks before that. */
  attendance: { recentWorked: number; recentTeamDays: number; priorWorked: number; priorTeamDays: number };
  /** Gauge days in the last completed week and the team's event dates in it. */
  lastWeek: { workedDays: number; teamEventDays: number };
  /** Payroll gross for the last 8 completed weeks, oldest first (a week without a run = 0). */
  weeklyGross: ReadonlyArray<number>;
  /** Totals over the last 4 completed weeks (trainee_slow). */
  last4Weeks: GaugeTotals;
}

/** Every reason that fires for one person (with the suppressions: sustained_decline drops conversion_drop, zero_week drops attendance_drop). */
export function personSignals(input: PersonSignalInput): CheckInReason[] {
  void input;
  return [];
}

/** Drops scores < CHECK_IN_RULES.minScore, sorts by score desc then name, keeps the top CHECK_IN_RULES.maxPeople. */
export function rankCheckIns(people: ReadonlyArray<CheckInPerson>): CheckInPerson[] {
  void people;
  return [];
}
