import { run, type Db } from './connection.ts';
import { todayISO } from '../lib/dates.ts';

/**
 * Keep event statuses honest when the database is older than today: past `scheduled`/`live` events become
 * `completed` and today's `scheduled` events become `live`. Cancelled events are left alone.
 */
export function rollForwardEventStatuses(db: Db, today = todayISO()): { completed: number; live: number } {
  const completed = run(db, `UPDATE events SET status = 'completed' WHERE status IN ('scheduled', 'live') AND date < ?`, [today]).changes;
  const live = run(db, `UPDATE events SET status = 'live' WHERE status = 'scheduled' AND date = ?`, [today]).changes;
  return { completed, live };
}
