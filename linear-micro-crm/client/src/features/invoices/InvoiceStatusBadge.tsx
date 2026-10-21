// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// The invoice's status on a payroll row (Issued, Accepted, Deemed accepted, Disputed, Resolved) from run.invoice.
// Mounted in features/finance/PayrollRunsTable.tsx (P1's) in the Status cell after the payroll status badge, in an
// ErrorBoundary with fallback={null}. Inline element only (it sits in a table cell's flex row).
import type { PayrollRunWithUser } from '@lm/shared';

export interface InvoiceStatusBadgeProps {
  run: PayrollRunWithUser;
}

export function InvoiceStatusBadge(_props: InvoiceStatusBadgeProps) {
  return null;
}
