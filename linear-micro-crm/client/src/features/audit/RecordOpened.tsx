// Release 1.3 slot — OWNED BY P9 audit-everything (laid down by r3-foundation; does nothing until P9 fills it).
// Reports "opened a sensitive record" to the audit trail once per mount (api/auditEvents.ts reportAuditEvent, kind
// 'opened'). Renders nothing, ever. Mounted, each in an ErrorBoundary with fallback={null}: pages/CandidateDetail.tsx
// (entity 'candidate'), features/finance/PayslipModal.tsx (entity 'payroll_run'; P2 switches it to 'invoice' when the
// invoice view lands), pages/Audit.tsx (entity null: the audit trail itself). P9 decides whether opening is recorded
// here or server-side; either way the mount points stay.
import type { AuditEntity } from '@lm/shared';

export interface RecordOpenedProps {
  entity: AuditEntity | null;
  entityId: number | null;
  /** What was opened, e.g. "candidate profile", "payslip", "audit trail". */
  what: string;
}

export function RecordOpened(_props: RecordOpenedProps) {
  return null;
}
