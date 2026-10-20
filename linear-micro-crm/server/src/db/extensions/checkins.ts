/**
 * Release 1.2 — OWNED BY U4 check-ins. The one-tap shift check-in:
 *   check_ins(id, user_id, event_id, date, checked_in_at, source, created_at, UNIQUE(user_id, event_id, date)).
 * A check-in is never a gauge row and never a day worked (pay counts distinct gauge dates only). Not to be confused
 * with the 1.1 "Check in with…" list (lib/smart/checkIns.ts, shared CheckInPerson), which is about leaders talking to
 * people. Rules: ./types.ts.
 *
 *  - `checked_in_at` is naive Europe/London wall-clock time (the format of gauge_entries.checked_in_at), so
 *    punctuality compares like with like against the event's start time.
 *  - `created_at` is the ISO instant the row was written (business clock); the 2-minute self-undo counts from it.
 *  - The unique key makes POST /checkins idempotent: a phone replaying a tap, or a second tap, never adds a row.
 *  - Nothing to upgrade: the table is new in 1.2 (an existing database gets it from `sql` on its next start).
 *  - `seed` (fresh demo only): today's started events get the check-ins a real morning would have: everyone who
 *    logged today and recorded a check-in time taps in at that very time, so punctuality reads exactly as before.
 *    It reads gauge_entries and writes check_ins only.
 */
import type { Db } from '../connection.ts';
import type { DbExtension, SeedContext } from './types.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS check_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  checked_in_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'button' CHECK (source IN ('button', 'quick', 'offline', 'leader')),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, event_id, date)
);
CREATE INDEX IF NOT EXISTS idx_check_ins_event ON check_ins(event_id, date);
`;

/** "HH:MM" or "HH:MM:SS" naive time → the same wall-clock string with seconds. */
const withSeconds = (ts: string) => (ts.length === 16 ? `${ts}:00` : ts.slice(0, 19));

function seedCheckIns(db: Db, ctx: SeedContext): void {
  const nowMs = Date.parse(ctx.nowIso);
  if (!Number.isFinite(nowMs)) return;
  const todays = ctx.events.filter((e) => e.date === ctx.today && (e.status === 'live' || e.status === 'completed'));
  if (!todays.length) return;
  const rng = ctx.rng(4004);

  // The day's gauge rows (read only): their check-in time is what the person recorded, so the tap matches it.
  const logged = new Map<string, string | null>();
  for (const r of db.prepare(`SELECT user_id AS userId, event_id AS eventId, checked_in_at AS checkedInAt FROM gauge_entries WHERE date = ?`).all(ctx.today) as {
    userId: number;
    eventId: number;
    checkedInAt: string | null;
  }[]) {
    logged.set(`${Number(r.userId)}|${Number(r.eventId)}`, r.checkedInAt);
  }

  const insert = db.prepare(
    `INSERT INTO check_ins (user_id, event_id, date, checked_in_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, event_id, date) DO NOTHING`,
  );
  for (const ev of todays) {
    for (const u of ctx.users) {
      if (u.teamId !== ev.teamId || u.status !== 'active' || u.startDate > ctx.today) continue;
      if (u.role !== 'rep' && u.role !== 'leader') continue;
      // Only people who worked today (a gauge row) and recorded a check-in time tap in, at that very time; the
      // rest of the team shows as "not checked in" on the roll call.
      const recorded = logged.get(`${u.id}|${ev.id}`);
      if (!recorded) continue;
      const at = withSeconds(recorded);
      const ms = new Date(at).getTime();
      if (at.slice(0, 10) !== ev.date || !Number.isFinite(ms) || ms > nowMs) continue;
      insert.run(u.id, ev.id, ev.date, at, rng.chance(0.3) ? 'quick' : 'button', new Date(ms).toISOString());
    }
  }
}

export const extension: DbExtension = {
  name: 'checkins',
  sql: SQL,
  upgrade: () => [],
  seed: seedCheckIns,
};
