// Release 1.2 slot — OWNED BY U5 office-tools (laid down by r2-foundation; renders nothing until U5 fills it).
// "Export for payroll": the selected week's runs as CSV for Xero Payroll or Sage (GET /finance/payroll/export, admin).
// Mounted in pages/Finance.tsx in the "Runs to pay" card header actions (admin only), before "Export CSV", in an
// ErrorBoundary with fallback={null}. `runs` are the runs to pay the card lists (to offer their weeks).
import type { PayrollRunWithUser } from '@lm/shared';

export interface PayExportButtonProps {
  runs: PayrollRunWithUser[];
  className?: string;
}

export function PayExportButton(_props: PayExportButtonProps) {
  return null;
}
