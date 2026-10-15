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

/** Who may look at another person's gauges / performance. */
export function canViewUser(me: UserWithTeam, target: UserWithTeam): boolean {
  if (isAdmin(me) || me.id === target.id) return true;
  if (isLeader(me)) return true; // leaders have the company view
  return me.teamId !== null && me.teamId === target.teamId; // reps/recruiters: own team only
}

export function assertCanViewUser(me: UserWithTeam, target: UserWithTeam): void {
  if (!canViewUser(me, target)) throw forbidden('You can only view people in your own team');
}

/** Who may create/edit a gauge entry for `target` at `event`. */
export function assertCanWriteGauge(me: UserWithTeam, target: UserWithTeam, event: SalesEventWithMeta): void {
  if (isAdmin(me)) return;
  if (isLeader(me)) {
    if (target.id === me.id || (me.teamId !== null && target.teamId === me.teamId)) return;
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
