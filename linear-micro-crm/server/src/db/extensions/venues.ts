/**
 * Release 1.3 — OWNED BY P8 venue-insights (laid down by r3-foundation: the table is the contract).
 *
 *  - event_roster: who is booked on an event — one row per (event, person), who booked them and when, source 'leader'
 *    (a leader or the admin booked them) or 'self' (they tapped "I'm working this"). Removed with the event.
 * Venues need no table: every per-venue figure is grouped by the shared venueKey(venue, city).
 * Rules: ./types.ts. Never write gauge rows from a booking.
 *
 * Upgrade: nothing to do — an existing database gets the empty table from `sql` and nobody is booked until a leader books.
 * Seed (fresh demo only): bookings on the scheduled and live events of the next two weeks, from this extension's own
 * random stream — the event team's active field members who had started by the day. The coming week is the leader's
 * roster: nine in ten booked, most of them by the leader (the rest booked themselves). Further out the leader has not
 * done the roster yet: about two in five have tapped "I'm working this" (self-bookings only, so the forecast keeps the
 * team's usual turnout as its floor — shared expectedHeadcount). The demo rep (Jordan Lee, LM-0010) is
 * booked on his team's first three upcoming events (two by his leader, one by himself) and NOT on the fourth, so both
 * the plan and the "I'm working this" button show; the demo leader (Amelia Hart) books herself on today's event. Only
 * event_roster rows are written (the core tables stay byte-for-byte the same).
 */
import type { DbExtension, SeedContext, SeedUserRef } from './types.ts';
import type { Db } from '../connection.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS event_roster (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booked_by INTEGER,
  booked_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_roster_user ON event_roster(user_id);
`;

/** This extension's random stream (SeedContext.rng). */
const SEED_SALT = 8008;
/** Bookings cover the scheduled and live events of today and the next 13 days. */
const SEED_DAYS = 14;
const DEMO_REP = 'LM-0010';
const DEMO_LEADER = 'LM-0002';

const addDaysISO = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A booking time before the seed's clock: `daysBefore` days before today at 18:00–21:59 (never in the future). */
function bookedAt(ctx: SeedContext, daysBefore: number, minute: number): string {
  const day = addDaysISO(ctx.today, -Math.max(1, daysBefore));
  const hh = 18 + Math.floor(minute / 60);
  const mm = minute % 60;
  const at = `${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;
  return at < ctx.nowIso ? at : ctx.nowIso;
}

function seedRoster(db: Db, ctx: SeedContext): void {
  const rng = ctx.rng(SEED_SALT);
  const last = addDaysISO(ctx.today, SEED_DAYS - 1);
  const upcoming = ctx.events
    .filter((e) => (e.status === 'scheduled' || e.status === 'live') && e.date >= ctx.today && e.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.id - b.id);
  const field = (u: SeedUserRef) => u.status === 'active' && (u.role === 'rep' || u.role === 'leader');
  const leaderOf = new Map(ctx.teams.map((t) => [t.id, t.leaderId]));
  const rep = ctx.users.find((u) => u.employeeId === DEMO_REP);
  const leader = ctx.users.find((u) => u.employeeId === DEMO_LEADER);
  const repEvents = rep ? upcoming.filter((e) => e.teamId === rep.teamId) : [];
  const insert = db.prepare(`INSERT OR IGNORE INTO event_roster (event_id, user_id, booked_by, booked_at, source) VALUES (?, ?, ?, ?, ?)`);

  for (const ev of upcoming) {
    const ahead = Math.round((Date.parse(`${ev.date}T12:00:00Z`) - Date.parse(`${ctx.today}T12:00:00Z`)) / 86_400_000);
    const leaderRoster = ahead <= 6;
    const chance = leaderRoster ? 0.9 : 0.4;
    const teamLeader = leaderOf.get(ev.teamId) ?? null;
    const members = ctx.users.filter((u) => field(u) && u.teamId === ev.teamId && u.startDate <= ev.date);
    for (const u of members) {
      // every draw happens for every member, so the demo overrides below never shift anyone else's bookings
      const book = rng.chance(chance);
      const byLeader = rng.chance(0.8);
      const daysBefore = 1 + Math.floor(rng.float(0, 4));
      const minute = Math.floor(rng.float(0, 240));
      let booked = book;
      let self = !leaderRoster || !byLeader || teamLeader == null || teamLeader === u.id;
      if (rep && u.id === rep.id) {
        const i = repEvents.indexOf(ev);
        if (i >= 0 && i <= 3) {
          booked = i <= 2;
          self = i === 1;
        }
      }
      if (leader && u.id === leader.id && ev.date === ctx.today) {
        booked = true;
        self = true;
      }
      if (!booked) continue;
      insert.run(ev.id, u.id, self ? u.id : teamLeader, bookedAt(ctx, daysBefore, minute), self ? 'self' : 'leader');
    }
  }
}

export const extension: DbExtension = {
  name: 'venues',
  sql: SQL,
  upgrade: () => [],
  seed: seedRoster,
};
