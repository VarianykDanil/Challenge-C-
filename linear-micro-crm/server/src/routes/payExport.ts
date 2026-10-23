/**
 * Release 1.2 — GET /finance/payroll/export — OWNED BY U5 office-tools.
 *
 *  GET /finance/payroll/export?weekStart=YYYY-MM-DD&format=xero|sage[&runs=unpaid|all] → text/csv attachment (admin
 *  only): one pay week's payroll runs for Xero Payroll or Sage (columns: shared PayExportRow, formula-injection
 *  guarded; shared/src/logic/payExport.ts). `runs=unpaid` (default) exports what is still to pay — pending runs and
 *  failed transfers — and `runs=all` every run of the week. Sorted by surname then first name. `X-Total-Count` = rows.
 *  A week without runs answers the header line alone. Never cached (Cache-Control: no-store): it carries employee IDs.
 *  400: weekStart missing, not a date or not a Monday; format or runs not one of the values above.
 *
 * It may first create the pending runs of weeks that have closed, exactly as GET /finance/payroll does
 * (ensurePayrollMaterialised, so the file matches what the Finance page lists); it never changes a paid run. That
 * guard only runs when the last closed week has no runs yet, and when it creates runs it also brings the week
 * before's unpaid runs back in line with the gauges and moves the data version (materialisePayrollRuns), so every
 * cached view is rebuilt on its next read — the same as after GET /finance/payroll. Otherwise the export only reads.
 * The export itself is recorded in the audit trail (recordAudit, U3) because payroll data leaves the system.
 * Mounted in app.ts at /finance/payroll/export BEFORE the /finance router (whose /payroll/:id would catch "export").
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  PAY_EXPORT_FORMATS,
  PAY_EXPORT_FORMAT_LABELS,
  PAY_EXPORT_SCOPES,
  payExportCsv,
  payExportFilename,
  payExportRows,
  round2,
  type PayExportFormat,
  type PayExportScope,
  type PayrollRunWithUser,
} from '@lm/shared';
import type { Db } from '../db/connection.ts';
import { ensurePayrollMaterialised } from '../db/maintenance.ts';
import { Where, listPayroll } from '../db/queries.ts';
import { recordAudit } from '../lib/audit.ts';
import { dayOfWeek, formatWeek, todayISO } from '../lib/dates.ts';
import { personOrderSql } from '../lib/people.ts';
import { isoDate } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const exportQuery = z.object({
  weekStart: isoDate.refine((d) => dayOfWeek(d) === 1, 'weekStart must be a Monday'),
  format: z.enum(PAY_EXPORT_FORMATS as [PayExportFormat, ...PayExportFormat[]]),
  runs: z.enum(PAY_EXPORT_SCOPES as [PayExportScope, ...PayExportScope[]]).default('unpaid'),
});

/** The week's runs, unpaid (pending + failed) or all, by surname (or the first name when there is none). One query. */
export function payExportRuns(db: Db, weekStart: string, scope: PayExportScope): PayrollRunWithUser[] {
  const where = new Where().add('p.week_start = ?', weekStart);
  if (scope === 'unpaid') where.add(`p.status IN ('pending', 'failed')`);
  return listPayroll(db, `${where}`, where.params, `${personOrderSql('u')}, p.id ASC`);
}

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function payExportRouter(db: Db): Router {
  const router = Router();
  router.get('/', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const query = exportQuery.parse({ weekStart: req.query.weekStart, format: req.query.format, runs: req.query.runs ?? undefined });
    // A week that has just closed gets its pending runs first (as GET /finance/payroll does); when that creates runs,
    // materialisePayrollRuns moves the data version itself, so the cached views are cleared exactly as there.
    ensurePayrollMaterialised(db, todayISO());
    const runs = payExportRuns(db, query.weekStart, query.runs);
    const csv = payExportCsv(payExportRows(runs), query.format);
    const gross = round2(runs.reduce((sum, r) => sum + r.gross, 0));
    try {
      recordAudit(db, {
        userId: me.id,
        action: 'GET /finance/payroll/export',
        entity: 'payroll_run',
        entityId: null,
        summary: `Exported payroll for ${PAY_EXPORT_FORMAT_LABELS[query.format]}: ${formatWeek(query.weekStart)}, ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}${query.runs === 'all' ? ' (all statuses)' : ''}, ${GBP.format(gross)}`,
        ip: req.ip ?? null,
      });
    } catch {
      /* the audit trail never blocks the export */
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${payExportFilename(query.weekStart, query.format)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Total-Count', String(runs.length));
    res.status(200).send(csv);
  });
  return router;
}
