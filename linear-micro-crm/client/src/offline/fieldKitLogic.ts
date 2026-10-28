// The field kit, the pure part (src/offline/fieldKit.ts keeps it in localStorage). It is what lets Linear Hub open on a
// phone with no signal: who was last signed in here (first name, role, team: no email, employee ID, phone or pay
// details) and the events they can log gauges against (event names, places and times, which the gauge outbox already
// keeps too). Nothing in it is a secret and the server still checks everything: a save made from it waits in the
// outbox and is sent only once that same person is signed in again.
//
// It lasts no longer than the sign-in it came from: the phone opens offline as that person only until the session
// would have ended anyway (the hours-from-sign-in limit, 14 by default) and only while the inactivity sign-out
// (12 hours by default) has not passed since the app last reached the server. After that it needs signal and a
// sign-in, as it would online. Only reps and leaders get one: they are the people who log gauges and check in at
// events, often in places with no signal.
import { SESSION_IDLE_HOURS_DEFAULT, type Role, type SalesEventWithMeta, type SessionInfo, type UserWithTeam } from '@lm/shared';

const HOUR_MS = 3_600_000;
/** The loggable window is three weeks of one team's events; this is plenty. */
export const KIT_MAX_EVENTS = 60;
/**
 * With no session end to go by (a demo account's 14-day session, or a server that did not say), the phone opens
 * offline for at most this long after the app last reached the server.
 */
export const KIT_NO_SESSION_HOURS = 14;
/** The people who log gauges and check in at events. */
const KIT_ROLES: readonly Role[] = ['rep', 'leader'];
/** 2: bounded by the session (1, a 7-day kit with the employee ID, is ignored). */
const VERSION = 2;

export interface KitUser {
  id: number;
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
  /** The last time the server answered for this person (sign-in, the session check, their events). */
  savedAt: number;
  /** When the session it came from ends (ms). */
  endsAt: number;
  /** The inactivity sign-out, counted from savedAt (ms). */
  idleMs: number;
  user: KitUser;
  events: SalesEventWithMeta[];
}

/** Does this role keep a field kit? */
export function keepsKit(role: Role): boolean {
  return KIT_ROLES.includes(role);
}

export function projectUser(u: UserWithTeam): KitUser {
  return {
    id: u.id,
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

/** When a kit made `now` from this session stops working offline. */
function sessionEnd(session: SessionInfo | undefined, now: number): number {
  const ends = session ? Date.parse(session.endsAt) : Number.NaN;
  if (!session || session.maxHours === null || !Number.isFinite(ends)) return now + KIT_NO_SESSION_HOURS * HOUR_MS;
  return ends;
}

function idleMsOf(session: SessionInfo | undefined): number {
  const h = session?.idleHours;
  return (typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : SESSION_IDLE_HOURS_DEFAULT) * HOUR_MS;
}

/**
 * The kit after `user` signs in or the session is confirmed (`session`: the session details the server sent with it).
 * A different person starts an empty kit; null for a role that keeps none.
 */
export function withUser(kit: FieldKit | null, user: UserWithTeam, now: number, session: SessionInfo | undefined): FieldKit | null {
  if (!keepsKit(user.role)) return null;
  const same = kit?.user.id === user.id;
  return {
    v: VERSION,
    savedAt: now,
    endsAt: sessionEnd(session, now),
    idleMs: idleMsOf(session),
    user: projectUser(user),
    events: same && kit ? kit.events : [],
  };
}

/** The server answered for this person again: the inactivity time starts again (the session's end never moves). */
export function touchKit(kit: FieldKit, now: number): FieldKit {
  return { ...kit, savedAt: Math.max(kit.savedAt, now) };
}

/** The kit with the events `userId` can log against (ignored when the kit belongs to someone else). */
export function withEvents(kit: FieldKit, userId: number, events: SalesEventWithMeta[], now: number): FieldKit {
  if (kit.user.id !== userId) return kit;
  const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime) || a.id - b.id);
  return { ...touchKit(kit, now), events: sorted.slice(0, KIT_MAX_EVENTS) };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** True while the kit may open the app offline. */
export function kitUsable(kit: FieldKit, now: number): boolean {
  return now < kit.endsAt && now - kit.savedAt < kit.idleMs;
}

/** A stored kit, or null when it is missing, broken, from another version, or past its session. */
export function parseKit(raw: string | null, now: number): FieldKit | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as Partial<FieldKit> | null;
    if (!k || k.v !== VERSION || !isNum(k.savedAt) || !isNum(k.endsAt) || !isNum(k.idleMs)) return null;
    const u = k.user as Partial<KitUser> | undefined;
    if (!u || !isId(u.id) || u.id <= 0 || !isStr(u.firstName) || !isStr(u.role) || !keepsKit(u.role as Role)) return null;
    const kit: FieldKit = {
      v: VERSION,
      savedAt: k.savedAt,
      endsAt: k.endsAt,
      idleMs: k.idleMs,
      user: u as KitUser,
      events: Array.isArray(k.events) ? k.events.filter((e) => e && isId(e.id) && isStr(e.date) && isId(e.teamId)) : [],
    };
    return kitUsable(kit, now) ? kit : null;
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
    employeeId: '',
    email: '',
    phone: null,
    city: null,
    payPlanId: 0,
    payPlanName: '',
  };
}
