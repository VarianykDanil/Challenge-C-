/** Role-scoping rules from docs/API.md, shared by the routers. */
import type { SalesEventWithMeta, UserWithTeam } from '@lm/shared';
import { forbidden } from './errors.ts';

export const isAdmin = (me: UserWithTeam) => me.role === 'admin';
export const isLeader = (me: UserWithTeam) => me.role === 'leader';

/** Leaders manage their own team; admins manage everything. */
export function canManageTeam(me: UserWithTeam, teamId: number | null): boolean {
  if (isAdmin(me)) return true;
  return isLeader(me) && me.teamId !== null && me.teamId === teamId;
}

/** Who may create/edit a gauge entry for `target` at `event`. */
export function assertCanWriteGauge(me: UserWithTeam, target: UserWithTeam, event: SalesEventWithMeta): void {
  if (isAdmin(me)) return;
  if (isLeader(me)) {
    if (me.teamId === null || event.teamId !== me.teamId) throw forbidden("Leaders can only record gauges at their own team's events");
    if (target.id === me.id || target.teamId === me.teamId) return;
    throw forbidden('Leaders can only record gauges for their own team');
  }
  if (me.role === 'rep') {
    if (target.id !== me.id) throw forbidden('Reps can only record their own gauges');
    if (me.teamId === null || event.teamId !== me.teamId) throw forbidden('Reps can only record gauges for events of their own team');
    return;
  }
  throw forbidden('Your role cannot record gauges');
}

/** Who may see a payroll run. */
export function canViewPayroll(me: UserWithTeam, run: { userId: number; teamId?: number | null }, targetTeamId: number | null): boolean {
  if (isAdmin(me) || run.userId === me.id) return true;
  return isLeader(me) && me.teamId !== null && me.teamId === targetTeamId;
}

/** The employee ID is half of the sign-in credential: only admins and the person themselves may read it. */
export function canSeeEmployeeId(me: UserWithTeam, userId: number): boolean {
  return isAdmin(me) || me.id === userId;
}

/** Blanks `employeeId` on a user payload unless `me` may see it (the field stays in the type as ''). */
export function redactUser<T extends { id: number; employeeId: string }>(me: UserWithTeam, user: T): T {
  return canSeeEmployeeId(me, user.id) ? user : { ...user, employeeId: '' };
}

/** Same rule for payroll rows and payslips, which embed the run owner's employee ID. */
export function redactPayroll<T extends { userId: number; employeeId: string }>(me: UserWithTeam, run: T): T {
  return canSeeEmployeeId(me, run.userId) ? run : { ...run, employeeId: '' };
}

/**
 * Who may see the personal details on a gauge entry (check-in time, notes): admins, the person themselves and the
 * leader of that person's team. Everyone else gets the numbers only.
 */
export function canSeeEntryDetails(me: UserWithTeam, owner: { id: number; teamId: number | null }): boolean {
  if (isAdmin(me) || me.id === owner.id) return true;
  return isLeader(me) && me.teamId !== null && me.teamId === owner.teamId;
}

/** Nulls `checkedInAt` and `notes` on an entry unless `me` may see them (`teamId` on the entry is the owner's team). */
export function redactEntry<T extends { userId: number; teamId: number | null; checkedInAt: string | null; notes: string | null; checkInOnBehalf?: boolean }>(me: UserWithTeam, entry: T): T {
  if (canSeeEntryDetails(me, { id: entry.userId, teamId: entry.teamId })) return entry;
  // who recorded the check-in time goes with the time itself (review 1.2 S3)
  return { ...entry, checkedInAt: null, notes: null, ...(entry.checkInOnBehalf !== undefined ? { checkInOnBehalf: false } : {}) };
}
