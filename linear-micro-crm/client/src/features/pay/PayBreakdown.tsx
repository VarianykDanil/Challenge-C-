// Release 1.3 slot — OWNED BY P1 pay-rule (laid down by r3-foundation; renders nothing until P1 pay-rule fills it).
// The week's pay under the 1.3 rule: days × £63.50, commission per campaign (logged, cancelled, paid × rate), which one
// applies and why (shared payExplanation), bonus, adjustments from earlier weeks, total; "Pending: not yet confirmed by
// BCN" chips. Mounted in features/finance/PayslipModal.tsx (P2's) under the payslip's pay table, in an ErrorBoundary with
// fallback={null}; P2's invoice view keeps it mounted. Data: api/pay.ts usePayBreakdown(run.userId, run.weekStart).
import type { PayrollRunWithUser } from '@lm/shared';

export interface PayBreakdownProps {
  run: PayrollRunWithUser;
  className?: string;
}

export function PayBreakdown(_props: PayBreakdownProps) {
  return null;
}
