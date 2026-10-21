// Release 1.3 slot — OWNED BY P2 invoices (laid down by r3-foundation; renders nothing until P2 invoices fills it).
// The "Accept invoice" / "Something's wrong" bar for the supplier, and the invoice's status for everyone else.
// Mounted in features/finance/PayslipModal.tsx (P2's) above the payslip body, in an ErrorBoundary with fallback={null}.
import type { PayrollRunWithUser } from '@lm/shared';

export interface InvoiceActionsBarProps {
  run: PayrollRunWithUser;
  className?: string;
}

export function InvoiceActionsBar(_props: InvoiceActionsBarProps) {
  return null;
}
