// The field kit, the pure part (src/offline/fieldKit.ts keeps it in localStorage). It is what lets Linear Hub open on a
// phone with no signal: who was last signed in here (first name, role, team: no email, phone or pay details) and the
// events they can log gauges against (event names, places and times, which the gauge outbox already keeps too).
// Nothing in it is a secret and the server still checks everything: a save made from it waits in the outbox and is
// sent only once that same person is signed in again.
import type { Role, SalesEventWithMeta, UserWithTeam } from '@lm/shared';

/** A kit older than this is ignored: someone who has not opened the app online for a week signs in again first. */
export const KIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The loggable window is three weeks of one team's events; this is plenty. */
export const KIT_MAX_EVENTS = 60;
const VERSION = 1;

export interface KitUser {
  id: number;
  employeeId: string;
  firstName: string;
  lastName: string;
  role: Role;
  position: UserWithTeam['position'];
  teamId: number | null;
  teamName: string | null;
  avatarColor: string;
  status: UserWithTeam['status'];
  startDate: string;
}

export interface FieldKit {
  v: number;
  savedAt: number;
  user: KitUser;
  events: SalesEventWithMeta[];
}

export function projectUser(u: UserWithTeam): KitUser {
  return {
    id: u.id,
    employeeId: u.employeeId,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    position: u.position,
    teamId: u.teamId ?? null,
    teamName: u.teamName ?? null,
    avatarColor: u.avatarColor,
    status: u.status,
    startDate: u.startDate,
  };
}

/** The kit after `user` signs in or is confirmed: a different person starts an empty kit. */
export function withUser(kit: FieldKit | null, user: UserWithTeam, now: number): FieldKit {
  const same = kit?.user.id === user.id;
  return { v: VERSION, savedAt: now, user: projectUser(user), events: same && kit ? kit.events : [] };
}

/** The kit with the events `userId` can log against (ignored when the kit belongs to someone else). */
export function withEvents(kit: FieldKit, userId: number, events: SalesEventWithMeta[], now: number): FieldKit {
  if (kit.user.id !== userId) return kit;
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime) || a.id - b.id);
  return { ...kit, savedAt: now, events: sorted.slice(0, KIT_MAX_EVENTS) };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** A stored kit, or null when it is missing, broken, from another version or too old. */
export function parseKit(raw: string | null, now: number): FieldKit | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as Partial<FieldKit> | null;
    if (!k || k.v !== VERSION || !isNum(k.savedAt) || now - k.savedAt > KIT_MAX_AGE_MS) return null;
    const u = k.user as Partial<KitUser> | undefined;
    if (!u || !isNum(u.id) || u.id <= 0 || !isStr(u.firstName) || !isStr(u.role)) return null;
    const events = Array.isArray(k.events) ? k.events.filter((e) => e && isNum(e.id) && isStr(e.date) && isNum(e.teamId)) : [];
    return { v: VERSION, savedAt: k.savedAt, user: u as KitUser, events };
  } catch {
    return null;
  }
}

/** The signed-in shape the app expects, rebuilt from the kit; fields the kit never keeps are empty. */
export function kitUser(kit: FieldKit | null): UserWithTeam | null {
  if (!kit) return null;
  const u = kit.user;
  return {
    ...u,
    email: '',
    phone: null,
    city: null,
    payPlanId: 0,
    payPlanName: '',
  };
}
