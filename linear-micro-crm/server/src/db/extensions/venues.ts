/**
 * Release 1.3 — OWNED BY P8 venue-insights (laid down by r3-foundation: the table is the contract; P8 adds demo bookings
 * in `seed` and further columns with addColumnIfMissing).
 *
 *  - event_roster: who is booked on an event — one row per (event, person), who booked them and when, source 'leader'
 *    (a leader booked a team member) or 'self' (a rep tapped "I'm working this"). Removed with the event.
 * Venues need no table: every per-venue figure is grouped by the shared venueKey(venue, city).
 * Rules: ./types.ts. Never write gauge rows from a booking.
 */
import type { DbExtension } from './types.ts';

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

export const extension: DbExtension = {
  name: 'venues',
  sql: SQL,
  upgrade: () => [],
};
