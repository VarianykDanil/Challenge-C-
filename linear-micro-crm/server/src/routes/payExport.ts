/**
 * GET /finance/payroll/export — the payroll spreadsheet (CSV) for the accountant or payroll software.
 *
 *  GET /finance/payroll/export?weekStart=YYYY-MM-DD[&runs=unpaid|all][&people=all|self_billed|office][&format=csv]
 *  → text/csv attachment (admin only): one pay week's payroll runs (columns: shared PayExportRow, formula-injection
 *  guarded; shared/src/logic/payExport.ts). Every row adds up: the parts and corrections (Adjustments) to the gross
 *  pay, gross pay + VAT (from the self-billed invoice) to the total to pay. `runs=unpaid` (default) exports what is still
 *  to pay — pending runs and failed transfers — and `runs=all` every run of the week. `people=self_billed` keeps the
 *  self-employed field people (reps, leaders), `people=office` the office staff. `format=xero` / `sage` (older links)
 *  give the same file: it is not either product's import layout. Sorted by surname then first name.
 *  `X-Total-Count` = rows. A week without runs answers the header line alone. Never cached (Cache-Control: no-store):
 *  it carries employee IDs. 400: weekStart missing, not a date or not a Monday; format, runs or people not one of the
 *  values above.
 *
 * It may first create the pending runs of weeks that have closed, exactly as GET /finance/payroll does
 * (ensurePayrollMaterialised, so the file matches what the Finance page lists); it never changes a paid run. That
 * guard only runs when the last closed week has no runs yet, and when it creates runs it also brings the week
 * before's unpaid runs back in line with the gauges and moves the data version (materialisePayrollRuns), so every
 * cached view is rebuilt on its next read — the same as after GET /finance/payroll. Otherwise the export only reads.
 * The export itself is recorded in the audit trail (recordAudit) because payroll data leaves the system.
 * Mounted in app.ts at /finance/payroll/export BEFORE the /finance router (whose /payroll/:id would catch "export").
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  PAY_EXPORT_FORMATS,
  PAY_EXPORT_PEOPLE,
  PAY_EXPORT_PEOPLE_LABELS,
  PAY_EXPORT_SCOPES,
  amountToPayPence,
  inPayExportPeople,
  payExportCsv,
  payExportFilename,
  payExportRows,
  penceToPounds,
  type PayExportFormat,
  type PayExportPeople,
  type PayExportRun,
  type PayExportScope,
  type PayrollRunWithUser,
  type Role,
} from '@lm/shared';
import { all, placeholders, type Db } from '../db/connection.ts';
import { ensurePayrollMaterialised } from '../db/maintenance.ts';
import { Where, listPayroll } from '../db/queries.ts';
import { recordAudit } from '../lib/audit.ts';
import { dayOfWeek, formatWeek, todayISO } from '../lib/dates.ts';
import { withInvoiceSummaries } from '../lib/invoices.ts';
import { personOrderSql } from '../lib/people.ts';
import { isoDate } from '../lib/validate.ts';
import { currentUser, requireRole } from '../middleware/auth.ts';

const exportQuery = z.object({
  weekStart: isoDate.refine((d) => dayOfWeek(d) === 1, 'weekStart must be a Monday'),
  format: z.enum(PAY_EXPORT_FORMATS as [PayExportFormat, ...PayExportFormat[]]).default('csv'),
  runs: z.enum(PAY_EXPORT_SCOPES as [PayExportScope, ...PayExportScope[]]).default('unpaid'),
  people: z.enum(PAY_EXPORT_PEOPLE as [PayExportPeople, ...PayExportPeople[]]).default('all'),
});

/** The week's runs, unpaid (pending + failed) or all, by surname (or the first name when there is none). One query. */
export function payExportRuns(db: Db, weekStart: string, scope: PayExportScope): PayrollRunWithUser[] {
  const where = new Where().add('p.week_start = ?', weekStart);
  if (scope === 'unpaid') where.add(`p.status IN ('pending', 'failed')`);
  return listPayroll(db, `${where}`, where.params, `${personOrderSql('u')}, p.id ASC`);
}

/** The runs with each person's role (who is self-billed), kept to `people`. */
function withRoles(db: Db, runs: readonly PayrollRunWithUser[], people: PayExportPeople): PayExportRun[] {
  const ids = [...new Set(runs.map((r) => r.userId))];
  const roles = new Map(ids.length
    ? all<{ id: number; role: Role }>(db, `SELECT id, role FROM users WHERE id IN (${placeholders(ids.length)})`, ids).map((u) => [Number(u.id), u.role])
    : []);
  return runs.map((r) => ({ ...r, role: roles.get(r.userId) ?? 'rep' })).filter((r) => inPayExportPeople(r.role, people));
}

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function payExportRouter(db: Db): Router {
  const router = Router();
  router.get('/', requireRole('admin'), (req, res) => {
    const me = currentUser(req);
    const query = exportQuery.parse({ weekStart: req.query.weekStart, format: req.query.format ?? undefined, runs: req.query.runs ?? undefined, people: req.query.people ?? undefined });
    // A week that has just closed gets its pending runs first (as GET /finance/payroll does); when that creates runs,
    // materialisePayrollRuns moves the data version itself, so the cached views are cleared exactly as there.
    ensurePayrollMaterialised(db, todayISO());
    const runs = withRoles(db, withInvoiceSummaries(db, payExportRuns(db, query.weekStart, query.runs), me), query.people);
    const csv = payExportCsv(payExportRows(runs));
    const toPay = penceToPounds(runs.reduce((sum, r) => sum + amountToPayPence(r.gross, r.invoice), 0));
    try {
      recordAudit(db, {
        userId: me.id,
        action: 'GET /finance/payroll/export',
        entity: 'payroll_run',
        entityId: null,
        summary: `Exported the payroll spreadsheet (CSV): ${formatWeek(query.weekStart)}, ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}${query.runs === 'all' ? ' (all statuses)' : ''}${query.people === 'all' ? '' : `, ${PAY_EXPORT_PEOPLE_LABELS[query.people].toLowerCase()}`}, ${GBP.format(toPay)} to pay`,
        ip: req.ip ?? null,
      });
    } catch {
      /* the audit trail never blocks the export */
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${payExportFilename(query.weekStart, query.people)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Total-Count', String(runs.length));
    res.status(200).send(csv);
  });
  return router;
}
