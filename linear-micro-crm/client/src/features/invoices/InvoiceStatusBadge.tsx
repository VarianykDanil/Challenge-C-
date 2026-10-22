// Release 1.3 slot — OWNED BY P2 invoices. The invoice's status on a payroll row (Issued, Accepted, Deemed accepted,
// Disputed, Resolved) from run.invoice, with the deadline in its hover text. Mounted in
// features/finance/PayrollRunsTable.tsx (P1's) in the Status cell after the payroll status badge, in an ErrorBoundary
// with fallback={null}. Inline element only (it sits in a table cell's flex row); nothing for a run without an invoice.
import type { PayrollRunWithUser } from '@lm/shared';
import { INVOICE_STATUS_LABELS } from '@lm/shared';
import { Badge } from '@/components/ui';
import { statusHint, statusTone } from './invoiceText';

export interface InvoiceStatusBadgeProps {
  run: PayrollRunWithUser;
}

export function InvoiceStatusBadge({ run }: InvoiceStatusBadgeProps) {
  const inv = run.invoice;
  if (!inv) return null;
  const hint = statusHint(inv.status, inv.deemedAcceptedAt);
  return (
    <Badge tone={statusTone(inv.status)} variant={inv.status === 'deemed_accepted' ? 'outline' : 'soft'} title={hint} aria-label={`Invoice ${INVOICE_STATUS_LABELS[inv.status].toLowerCase()}: ${hint}`} data-invoice-status={inv.status}>
      {inv.status === 'issued' ? 'Invoice issued' : `Invoice ${INVOICE_STATUS_LABELS[inv.status].toLowerCase()}`}
    </Badge>
  );
}
