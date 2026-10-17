// CSV column sets for the finance tables (payroll runs, campaign finance, weekly money flow, expenses).
import type { CampaignFinance, Expense, FinanceWeek, PayrollRunWithUser, Position } from '@lm/shared';
import { EXPENSE_CATEGORY_LABELS, POSITION_LABELS } from '@lm/shared';
import { csvDate, csvLabel, csvMoney, csvPct, csvYesNo, type CsvColumn } from '@/lib/csv';
import { PAYROLL_STATUS_LABELS } from '@/lib/labels';

/**
 * Payslip rows; `showUser` adds the person columns for team and company views. `position` is the single person's
 * position for a personal export: a recruiter's payroll `sales` figure is their hire count, so the header says so.
 */
export function payrollRunCsvColumns(showUser = false, position?: Position): CsvColumn<PayrollRunWithUser>[] {
  const salesHeader = position === 'recruiter' ? 'Hires' : showUser ? 'Sales (hires for recruiters)' : 'Sales';
  const cols: CsvColumn<PayrollRunWithUser>[] = [
    { key: 'weekStart', header: 'Week start', format: csvDate },
    { key: 'weekEnd', header: 'Week end', format: csvDate },
  ];
  if (showUser) {
    cols.push(
      { key: 'userName', header: 'Person' },
      { key: 'employeeId', header: 'Employee ID' },
      { key: 'position', header: 'Position', format: csvLabel(POSITION_LABELS) },
      { key: 'teamName', header: 'Team' },
    );
  }
  cols.push(
    { key: 'daysWorked', header: 'Days' },
    { key: 'sales', header: salesHeader },
    { key: 'basePay', header: 'Base', format: csvMoney },
    { key: 'commission', header: 'Commission', format: csvMoney },
    { key: 'bonus', header: 'Bonus', format: csvMoney },
    { key: 'overrides', header: 'Overrides', format: csvMoney },
    { key: 'deductions', header: 'Deductions', format: csvMoney },
    { key: 'gross', header: 'Gross', format: csvMoney },
    { key: 'dueDate', header: 'Due', format: csvDate },
    { key: 'paidDate', header: 'Paid', format: csvDate },
    { key: 'status', header: 'Status', format: csvLabel(PAYROLL_STATUS_LABELS) },
    { key: 'onTime', header: 'Paid on time', format: csvYesNo },
    { key: 'reference', header: 'Reference' },
  );
  return cols;
}

/** Company → "By campaign": sales, revenue, rep commission, margin and margin as a share of revenue. */
export const campaignFinanceCsvColumns: CsvColumn<CampaignFinance>[] = [
  { key: 'campaignName', header: 'Campaign' },
  { key: 'sales', header: 'Sales' },
  { key: 'revenue', header: 'Revenue', format: csvMoney },
  { key: 'commission', header: 'Commission', format: csvMoney },
  { key: 'margin', header: 'Margin', format: csvMoney },
  { key: 'marginPct', header: 'Margin %', format: (_, r) => (r.revenue ? csvPct(1)(r.margin / r.revenue) : '') },
];

/** Company → "Weekly money flow": one row per pay week (Mon–Sun). */
export const financeWeekCsvColumns: CsvColumn<FinanceWeek>[] = [
  { key: 'weekStart', header: 'Week (w/c)', format: csvDate },
  { key: 'revenue', header: 'Revenue', format: csvMoney },
  { key: 'payroll', header: 'Payroll', format: csvMoney },
  { key: 'expenses', header: 'Expenses', format: csvMoney },
  { key: 'profit', header: 'Profit', format: csvMoney },
  { key: 'sales', header: 'Sales' },
  { key: 'estimated', header: 'Estimated', format: (v) => (v === true ? 'Yes' : 'No') },
];

/** Company → "Expenses"; `campaignName` resolves the campaign id the same way the table does. */
export function expenseCsvColumns(campaignName: (id: number | null) => string | null): CsvColumn<Expense>[] {
  return [
    { key: 'date', header: 'Date', format: csvDate },
    { key: 'category', header: 'Category', format: csvLabel(EXPENSE_CATEGORY_LABELS) },
    { key: 'description', header: 'Description' },
    { key: 'campaignId', header: 'Campaign', format: (v) => campaignName(typeof v === 'number' ? v : null) ?? '' },
    { key: 'amount', header: 'Amount', format: csvMoney },
  ];
}

/** `{ from, to }` spanning a set of runs (for the file name); undefined when there are none. */
export function payrollRunsRange(runs: PayrollRunWithUser[]): { from: string; to: string } | undefined {
  if (runs.length === 0) return undefined;
  let from = runs[0]!.weekStart;
  let to = runs[0]!.weekEnd;
  for (const r of runs) {
    if (r.weekStart < from) from = r.weekStart;
    if (r.weekEnd > to) to = r.weekEnd;
  }
  return { from, to };
}
