/**
 * Advisory payroll checks — OWNED BY p3-money-forecast-payroll-checks.
 * Stub laid down by p1-foundation-contracts: the exported names and signatures are final; p3 replaces the bodies.
 *
 * payrollFlagsFor: admin only (any other `me` → empty Map); pending / failed runs only; at most MAX_FLAGGED_RUNS runs
 * per call; 3 grouped queries (prior gross per user, daily sales per user, plans) plus weekPayFor per run.
 * Returns runId → flags; GET /finance/payroll and /finance/payroll/:id attach `flags` for every run id in the Map.
 */
import type { PayrollFlag, PayrollRunWithUser, UserWithTeam } from '@lm/shared';
import type { Db } from '../../db/connection.ts';
import { smartEnabled } from './enabled.ts';

export const MAX_FLAGGED_RUNS = 80;

export function payrollFlagsFor(db: Db, runs: readonly PayrollRunWithUser[], me: UserWithTeam): Map<number, PayrollFlag[]> {
  void db;
  void runs;
  void me;
  if (!smartEnabled() || me.role !== 'admin') return new Map();
  return new Map();
}
