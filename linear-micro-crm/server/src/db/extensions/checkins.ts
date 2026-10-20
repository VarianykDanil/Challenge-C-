/**
 * Release 1.2 — OWNED BY U4 check-ins (laid down empty by r2-foundation).
 * Planned: check_ins(id, user_id, event_id, date, checked_in_at, source, created_at, UNIQUE(user_id, event_id, date)).
 * A check-in is never a gauge row and never a day worked. Not to be confused with the 1.1 "Check in with…" list
 * (lib/smart/checkIns.ts, shared CheckInPerson), which is about leaders talking to people. Rules: ./types.ts.
 */
import type { DbExtension } from './types.ts';

export const extension: DbExtension = {
  name: 'checkins',
  sql: '',
  upgrade: () => [],
};
