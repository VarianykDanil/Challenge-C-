/**
 * Release 1.3 — OWNED BY P8 venue-insights: an event's roster (event_roster, db/extensions/venues.ts) — who is booked.
 *
 * Rules (docs/LOGIC.md §16.8):
 *  - Bookings are open while the event is scheduled or live and dated today or later (business clock). Completed and
 *    cancelled events keep their roster as it was: nobody can book on or come off them.
 *  - The admin books any active field member of staff (rep, leader or admin — recruiters work in the office); the
 *    leader of the event's team books their own team's active members and themself. People already booked stay
 *    booked when a leader saves the list again, even if they would not be bookable now (left the team, say).
 *  - "I'm working this" (self-booking): the admin on any event; a leader or rep on their own team's events. Anyone booked
 *    may take themself off ("I can't make it"), whoever booked them.
 *  - Someone who has left (users.status 'left') drops off every list and count — the roster, the booked counts, the
 *    plans and the forecasts — while their row stays as it was (back at work, they are booked again). A leader's save
 *    never touches it. Someone ON LEAVE stays booked and counted (re-review fix: they used to vanish too, against the
 *    documented rule), marked `onLeave` on the roster so the leader can take them off; they cannot be newly booked.
 *  - Edit bookings sends the CHANGES it made ({ add, remove }) rather than the list it loaded, so someone who tapped
 *    "I'm working this" while the leader had it open stays booked (re-review fix); the whole list ({ userIds }) still
 *    works as before.
 *  - Error messages name a person only when the caller may see them: the admin any member of staff, a leader their own
 *    team and themself. A client account, an unknown id, or (for a leader) anyone else is "Unknown person (id N)" or
 *    "That person is not on the … team (id N)".
 *  - Never creates a gauge row or touches pay. Every write is a mutating request, so the data version (and with it the
 *    response cache and the forecast memo) moves on its own.
 */
import type { EventBooking, EventBookingSummary, Role, SalesEventWithMeta, UserWithTeam } from '@lm/shared';
import { all, get, placeholders, run, transaction, type Db } from '../db/connection.ts';
import { nowISO, todayISO } from './dates.ts';
import { badRequest, conflict, forbidden } from './errors.ts';
import { canManageTeam } from './scope.ts';

/** Roles that work in the field and so can be booked on an event. */
export const BOOKABLE_ROLES: readonly Role[] = ['admin', 'leader', 'rep'];

/** The most people one roster save may name. */
export const ROSTER_MAX_PEOPLE = 200;

const ROSTER_SELECT = `
  SELECT r.event_id AS eventId, r.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, u.avatar_color AS avatarColor,
         r.booked_by AS bookedBy, CASE WHEN b.id IS NULL THEN NULL ELSE TRIM(b.first_name || ' ' || b.last_name) END AS bookedByName,
         r.booked_at AS bookedAt, r.source, u.status = 'on_leave' AS onLeave
  FROM event_roster r
  JOIN users u ON u.id = r.user_id AND u.status <> 'left'
  LEFT JOIN users b ON b.id = r.booked_by`;

const ROSTER_ORDER = `ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.id`;

/** Everyone booked on an event who has not left, by first name then last name (`onLeave` only when they are). */
export function listRoster(db: Db, eventId: number): EventBooking[] {
  return all<Omit<EventBooking, 'onLeave'> & { onLeave: number }>(db, `${ROSTER_SELECT} WHERE r.event_id = ? ${ROSTER_ORDER}`, [eventId]).map(({ onLeave, ...b }) =>
    Number(onLeave) === 1 ? { ...b, onLeave: true } : b,
  );
}

/** One person booked on an event, as a plan needs them (their team decides whether a leader sees their own numbers). */
export interface RosterPerson {
  userId: number;
  userName: string;
  avatarColor: string;
  teamId: number | null;
}

/** The people booked on an event who have not left, in the roster's order (for plans). */
export function rosterPeople(db: Db, eventId: number): RosterPerson[] {
  return all<RosterPerson>(
    db,
    `SELECT r.user_id AS userId, TRIM(u.first_name || ' ' || u.last_name) AS userName, u.avatar_color AS avatarColor, u.team_id AS teamId
     FROM event_roster r JOIN users u ON u.id = r.user_id AND u.status <> 'left'
     WHERE r.event_id = ? ${ROSTER_ORDER}`,
    [eventId],
  );
}

/**
 * One grouped query: people booked per event (not those who have left), and whether `meId` is among them. Events
 * nobody is booked on are absent.
 */
export function bookingSummaries(db: Db, eventIds: readonly number[], meId: number): Map<number, EventBookingSummary> {
  const out = new Map<number, EventBookingSummary>();
  if (!eventIds.length) return out;
  const rows = all<{ eventId: number; booked: number; me: number }>(
    db,
    `SELECT r.event_id AS eventId, COUNT(*) AS booked, MAX(r.user_id = ?) AS me
     FROM event_roster r JOIN users u ON u.id = r.user_id AND u.status <> 'left'
     WHERE r.event_id IN (${placeholders(eventIds.length)}) GROUP BY r.event_id`,
    [meId, ...eventIds],
  );
  for (const r of rows) out.set(Number(r.eventId), { booked: Number(r.booked), me: Number(r.me) === 1 });
  return out;
}

/** Throws 409 unless bookings are open on the event (scheduled or live, dated today or later). */
export function assertBookingsOpen(event: Pick<SalesEventWithMeta, 'status' | 'date'>): void {
  if (event.status === 'cancelled') throw conflict('This event is cancelled, so its bookings are closed');
  if (event.status === 'completed' || event.date < todayISO()) throw conflict('This event has finished, so its bookings are closed');
}

/** Who may book themself on the event ("I'm working this"): the admin anywhere; a leader or rep at their own team's events. */
export function assertCanBookSelf(me: UserWithTeam, event: Pick<SalesEventWithMeta, 'teamId'>): void {
  if (me.role === 'admin') return;
  if ((me.role === 'leader' || me.role === 'rep') && me.teamId != null && me.teamId === event.teamId) return;
  throw forbidden("You can only book yourself on your own team's events");
}

interface Candidate {
  id: number;
  name: string;
  role: Role;
  status: string;
  teamId: number | null;
}

/**
 * Replaces the event's roster with exactly `userIds` (deduplicated): people already booked keep their row (who booked
 * them, when, and how); people left out are taken off; new people are booked by `me` with source 'leader'. A new person
 * must be an active field member of staff — for a leader, a member of the event's team or the leader themself. Rows of
 * people who have left are not on the list the caller sees, so they are neither kept nor taken off here.
 * Returns the roster after the change.
 */
export function saveRoster(db: Db, me: UserWithTeam, event: SalesEventWithMeta, userIds: readonly number[]): EventBooking[] {
  if (!canManageTeam(me, event.teamId)) throw forbidden("Leaders can only book people on their own team's events");
  assertBookingsOpen(event);
  const wanted = [...new Set(userIds)];
  const current = new Set(
    all<{ userId: number }>(db, `SELECT r.user_id AS userId FROM event_roster r JOIN users u ON u.id = r.user_id AND u.status <> 'left' WHERE r.event_id = ?`, [event.id]).map((r) =>
      Number(r.userId),
    ),
  );
  const added = wanted.filter((id) => !current.has(id));
  if (added.length) {
    const found = new Map(
      all<Candidate>(
        db,
        `SELECT id, TRIM(first_name || ' ' || last_name) AS name, role, status, team_id AS teamId FROM users WHERE id IN (${placeholders(added.length)})`,
        added,
      ).map((u) => [Number(u.id), u]),
    );
    for (const id of added) {
      const u = found.get(id);
      // a client portal account is nobody on the staff side: the same answer as an id that does not exist
      if (!u || u.role === 'client') throw badRequest(`Unknown person (id ${id})`);
      // a leader may see their own team and themself; anyone else stays nameless
      if (me.role !== 'admin' && u.id !== me.id && u.teamId !== event.teamId) throw badRequest(`That person is not on the ${event.teamName} team (id ${id})`);
      if (u.status !== 'active' || !BOOKABLE_ROLES.includes(u.role)) throw badRequest(`${u.name} cannot be booked on an event`);
    }
  }
  const removed = [...current].filter((id) => !wanted.includes(id));
  if (added.length || removed.length) {
    transaction(db, () => {
      if (removed.length) run(db, `DELETE FROM event_roster WHERE event_id = ? AND user_id IN (${placeholders(removed.length)})`, [event.id, ...removed]);
      const at = nowISO();
      for (const id of added) {
        run(db, `INSERT OR IGNORE INTO event_roster (event_id, user_id, booked_by, booked_at, source) VALUES (?, ?, ?, ?, 'leader')`, [event.id, id, me.id, at]);
      }
    });
  }
  return listRoster(db, event.id);
}

/**
 * Edit bookings' changes (re-review fix): `add` booked by `me`, `remove` taken off, everyone else as they are now — so
 * a self-booking made while the leader had the list open is never lost. The same rules as saveRoster.
 */
export function changeRoster(db: Db, me: UserWithTeam, event: SalesEventWithMeta, add: readonly number[], remove: readonly number[]): EventBooking[] {
  if (!canManageTeam(me, event.teamId)) throw forbidden("Leaders can only book people on their own team's events");
  const off = new Set(remove);
  const now = all<{ userId: number }>(db, `SELECT r.user_id AS userId FROM event_roster r JOIN users u ON u.id = r.user_id AND u.status <> 'left' WHERE r.event_id = ?`, [event.id]).map((r) => Number(r.userId));
  return saveRoster(db, me, event, [...now.filter((id) => !off.has(id)), ...add.filter((id) => !off.has(id))]);
}

/** "I'm working this": books `me` (source 'self'); booking twice changes nothing. Returns the roster. */
export function bookSelf(db: Db, me: UserWithTeam, event: SalesEventWithMeta): EventBooking[] {
  assertCanBookSelf(me, event);
  assertBookingsOpen(event);
  run(db, `INSERT OR IGNORE INTO event_roster (event_id, user_id, booked_by, booked_at, source) VALUES (?, ?, ?, ?, 'self')`, [event.id, me.id, me.id, nowISO()]);
  return listRoster(db, event.id);
}

/** "I can't make it": takes `me` off the roster, whoever booked them; not booked changes nothing. Returns the roster. */
export function unbookSelf(db: Db, me: UserWithTeam, event: SalesEventWithMeta): EventBooking[] {
  const booked = get(db, `SELECT 1 FROM event_roster WHERE event_id = ? AND user_id = ?`, [event.id, me.id]);
  if (booked) {
    assertBookingsOpen(event);
    run(db, `DELETE FROM event_roster WHERE event_id = ? AND user_id = ?`, [event.id, me.id]);
  }
  return listRoster(db, event.id);
}
