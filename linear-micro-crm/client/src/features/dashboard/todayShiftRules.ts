// The dashboard's "Today" card (TodayShift.tsx): who gets it and which events it shows. Pure, tested in
// todayShiftRules.test.ts.
import type { Role, SalesEventWithMeta } from '@lm/shared';

/** Reps and leaders with a team: the people who check in and log gauges at their team's events. */
export function showsTodayCard(me: { role: Role; teamId: number | null }): boolean {
  return (me.role === 'rep' || me.role === 'leader') && me.teamId != null;
}

/** Today's events for my team that are not cancelled, earliest first. */
export function todaysShifts(events: SalesEventWithMeta[] | undefined, me: { role: Role; teamId: number | null }, today: string): SalesEventWithMeta[] {
  if (!events || !showsTodayCard(me)) return [];
  return events
    .filter((e) => e.date === today && e.status !== 'cancelled' && e.teamId === me.teamId)
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id - b.id);
}
