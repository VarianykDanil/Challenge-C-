/**
 * This week's pay estimate — OWNED BY p3-money-forecast-payroll-checks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p3 replaces the bodies.
 *
 * weekPayForecast: null unless the role is rep or leader and the user has a team. soFar from weekPayFor(monday,
 * today); remaining team event days to Sunday; trailing 8 completed weeks for λ and the ratios. An estimate only:
 * never written to payroll_runs and never changes nextPayAmount. Used by GET /finance/me (`forecast`) and
 * GET /me/insights (`personal.payForecast`).
 */
import type { PayForecast } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import type { PayUser } from '../pay.ts';
import { smartEnabled } from './enabled.ts';

export function weekPayForecast(db: Db, user: PayUser, today: string): PayForecast | null {
  void db;
  void user;
  void today;
  if (!smartEnabled()) return null;
  return null;
}
