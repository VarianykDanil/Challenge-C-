// Release 1.2 slot — OWNED BY U3 audit-trail (laid down by r2-foundation; renders nothing until U3 fills it).
// "History" of one record (GET /audit/:entity/:entityId): who changed what and when, with a field-level diff. Admins;
// leaders see their own team's gauge entry history. Mounted, each in an ErrorBoundary with fallback={null}:
//  - features/finance/PayslipModal.tsx, at the end of the payslip body (entity 'payroll_run');
//  - features/gauges/LogGaugesModal.tsx, under the form when an existing entry is open (entity 'gauge_entry').
import type { AuditEntity } from '@lm/shared';

export interface EntityHistoryProps {
  entity: AuditEntity;
  entityId: number;
  className?: string;
}

export function EntityHistory(_props: EntityHistoryProps) {
  return null;
}
