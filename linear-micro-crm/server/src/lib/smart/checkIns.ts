/**
 * The private "Check in with…" list — OWNED BY p4-leader-check-ins-coaching.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p4 replaces the bodies.
 *
 * checkInList(db, { teamId, excludeUserId }, today): people with status 'active' and role rep / leader — one team, or
 * every team when teamId is null — minus excludeUserId; ranked by shared rankCheckIns (≤ 5 people, score ≥ 2).
 * At most 6 queries regardless of size. Called ONLY from GET /me/insights: team (a leader's own team) and company
 * (admin). Reps and recruiters never receive it (P1 guarantees this in routes/insights.ts).
 */
import type { CheckInPerson } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { smartEnabled } from './enabled.ts';

export interface CheckInScope {
  /** One team, or null for every team (admin). */
  teamId: number | null;
  /** The caller: never on their own list. */
  excludeUserId: number;
}

export function checkInList(db: Db, scope: CheckInScope, today: string): CheckInPerson[] {
  void db;
  void scope;
  void today;
  if (!smartEnabled()) return [];
  return [];
}
